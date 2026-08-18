package com.knote.capacitor.android;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.UnsupportedEncodingException;
import java.net.HttpURLConnection;
import java.net.URI;
import java.net.SocketTimeoutException;
import java.net.URL;
import java.net.URLConnection;
import java.net.URLEncoder;
import java.nio.ByteBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.text.Normalizer;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashSet;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.ScheduledThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.regex.Pattern;
import javax.net.ssl.HttpsURLConnection;

final class WebSearchService {
    static final int MAX_QUERY_CODE_POINTS = 256;
    static final int MAX_RESULTS = 20;
    static final int MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
    static final String CANCELLED = "SEARCH_CANCELLED";
    static final String NETWORK_ERROR = "SEARCH_NETWORK_ERROR";
    static final String TIMEOUT = "SEARCH_TIMEOUT";
    static final String RATE_LIMITED = "SEARCH_RATE_LIMITED";
    static final String UPSTREAM_ERROR = "SEARCH_UPSTREAM_ERROR";
    static final String HTTP_ERROR = "SEARCH_HTTP_ERROR";
    static final String BLOCKED = "SEARCH_BLOCKED";
    static final String INVALID_CONTENT = "SEARCH_INVALID_CONTENT";
    static final String RESPONSE_TOO_LARGE = "SEARCH_RESPONSE_TOO_LARGE";
    static final String PARSER_ERROR = "SEARCH_PARSER_ERROR";
    static final String INVALID_INPUT = "INVALID_SEARCH_INPUT";
    static final String INVALID_ENGINE = "INVALID_SEARCH_ENGINE";

    private static final int CONNECT_TIMEOUT_MS = 5000;
    private static final int READ_TIMEOUT_MS = 8000;
    private static final int TOTAL_TIMEOUT_MS = 10_000;
    private static final long CONTENT_LENGTH_MISSING = -1L;
    private static final long CONTENT_LENGTH_INVALID = -2L;
    private static final Pattern REGION = Pattern.compile("^[a-z]{2}(?:-[a-z]{2,3})?$");
    private static final Pattern REQUEST_ID = Pattern.compile("^[A-Za-z0-9_-]{16,128}$");
    private static final List<String> AUTO_ENGINES = Collections.unmodifiableList(
        Arrays.asList("bing", "duckduckgo", "mojeek")
    );
    private static final Set<String> ENGINES = Collections.unmodifiableSet(
        new HashSet<>(Arrays.asList("auto", "bing", "duckduckgo", "mojeek"))
    );

    private final Object requestLock = new Object();
    private final Map<String, RequestState> requests = new HashMap<>();
    private final ConnectionFactory connectionFactory;
    private final ScheduledThreadPoolExecutor deadlineExecutor;
    private final int totalTimeoutMs;

    WebSearchService() {
        this(URL::openConnection, TOTAL_TIMEOUT_MS);
    }

    WebSearchService(ConnectionFactory connectionFactory, int totalTimeoutMs) {
        if (connectionFactory == null || totalTimeoutMs < 1) {
            throw new IllegalArgumentException("Search transport configuration is invalid");
        }
        this.connectionFactory = connectionFactory;
        this.totalTimeoutMs = totalTimeoutMs;
        deadlineExecutor = new ScheduledThreadPoolExecutor(1, runnable -> {
            Thread thread = new Thread(runnable, "knote-search-deadline");
            thread.setDaemon(true);
            return thread;
        });
        deadlineExecutor.setRemoveOnCancelPolicy(true);
        deadlineExecutor.setExecuteExistingDelayedTasksAfterShutdownPolicy(false);
    }

    void beginRequest(String requestId, Runnable queuedCancellation) throws KnoteException {
        if (!isValidRequestId(requestId)) {
            throw new KnoteException(ErrorCodes.TYPE_MISMATCH, "Invalid search request identifier");
        }
        if (queuedCancellation == null) {
            throw new KnoteException(ErrorCodes.TYPE_MISMATCH, "Search cancellation handler is missing");
        }
        synchronized (requestLock) {
            if (requests.containsKey(requestId)) {
                throw new KnoteException(ErrorCodes.TYPE_MISMATCH, "Duplicate search request identifier");
            }
            requests.put(requestId, new RequestState(queuedCancellation));
        }
    }

    boolean startRequest(String requestId) {
        synchronized (requestLock) {
            RequestState state = requests.get(requestId);
            if (state == null || state.cancelled || state.running) {
                return false;
            }
            state.running = true;
            state.queuedCancellation = null;
            return true;
        }
    }

    JSObject search(String query, int max, String engine, String region, String requestId) {
        String responseEngine = engine != null && ENGINES.contains(engine) ? engine : null;
        if (isCancelled(requestId)) {
            return toJsResponse(SearchAttempt.failure(CANCELLED, false), responseEngine, requestId);
        }
        if (engine == null || !ENGINES.contains(engine)) {
            return toJsResponse(SearchAttempt.failure(INVALID_ENGINE, false), null, requestId);
        }
        String safeRegion;
        try {
            validateQuery(query);
            if (max < 1 || max > MAX_RESULTS) {
                throw new KnoteException(ErrorCodes.TYPE_MISMATCH, "max must be between 1 and " + MAX_RESULTS);
            }
            safeRegion = validateRegion(region);
        } catch (KnoteException exception) {
            return toJsResponse(SearchAttempt.failure(INVALID_INPUT, false), responseEngine, requestId);
        }
        long deadlineNanos = deadlineAfterMillis(System.nanoTime(), totalTimeoutMs);

        if (!"auto".equals(engine)) {
            return toJsResponse(fetch(engine, query, max, safeRegion, deadlineNanos, requestId), engine, requestId);
        }
        SearchAttempt emptySuccess = null;
        String emptyEngine = null;
        SearchAttempt lastFailure = null;
        for (String candidate : AUTO_ENGINES) {
            if (isCancelled(requestId)) {
                return toJsResponse(SearchAttempt.failure(CANCELLED, false), "auto", requestId);
            }
            if (System.nanoTime() >= deadlineNanos) {
                return toJsResponse(SearchAttempt.failure(TIMEOUT, true), "auto", requestId);
            }
            SearchAttempt attempt = fetch(candidate, query, max, safeRegion, deadlineNanos, requestId);
            if (attempt.ok) {
                if (!attempt.results.isEmpty()) {
                    return toJsResponse(attempt, candidate, requestId);
                }
                if (emptySuccess == null) {
                    emptySuccess = attempt;
                    emptyEngine = candidate;
                }
            } else {
                lastFailure = attempt;
            }
        }
        if (emptySuccess != null) {
            return toJsResponse(emptySuccess, emptyEngine, requestId);
        }
        return toJsResponse(
            lastFailure == null ? SearchAttempt.failure(NETWORK_ERROR, true) : lastFailure,
            "auto",
            requestId
        );
    }

    boolean cancelRequest(String requestId) {
        List<HttpsURLConnection> connections;
        Runnable queuedCancellation;
        synchronized (requestLock) {
            RequestState state = requests.get(requestId);
            if (state == null) {
                return false;
            }
            state.cancelled = true;
            connections = new ArrayList<>(state.connections);
            state.connections.clear();
            queuedCancellation = state.queuedCancellation;
            state.queuedCancellation = null;
        }
        runCancellation(queuedCancellation);
        disconnectAll(connections);
        return true;
    }

    void cancelAll() {
        List<HttpsURLConnection> connections = new ArrayList<>();
        List<Runnable> queuedCancellations = new ArrayList<>();
        synchronized (requestLock) {
            for (RequestState state : requests.values()) {
                state.cancelled = true;
                connections.addAll(state.connections);
                state.connections.clear();
                if (state.queuedCancellation != null) {
                    queuedCancellations.add(state.queuedCancellation);
                    state.queuedCancellation = null;
                }
            }
        }
        for (Runnable cancellation : queuedCancellations) {
            runCancellation(cancellation);
        }
        disconnectAll(connections);
    }

    void shutdown() {
        cancelAll();
        deadlineExecutor.shutdownNow();
    }

    boolean isDeadlineExecutorShutdown() {
        return deadlineExecutor.isShutdown();
    }

    void finishRequest(String requestId) {
        synchronized (requestLock) {
            requests.remove(requestId);
        }
    }

    SearchAttempt fetch(
        String engine,
        String query,
        int max,
        String region,
        long deadlineNanos,
        String requestId
    ) {
        URI endpoint;
        try {
            endpoint = buildEndpoint(engine, query, max, region);
            validateEndpoint(engine, endpoint);
        } catch (KnoteException | RuntimeException exception) {
            return SearchAttempt.failure(INVALID_INPUT, false);
        }

        HttpsURLConnection connection = null;
        ScheduledFuture<?> deadlineDisconnect = null;
        AtomicBoolean deadlineTriggered = new AtomicBoolean();
        int responseStatus = 0;
        try {
            if (isCancelled(requestId)) {
                return SearchAttempt.failure(CANCELLED, false);
            }
            if (System.nanoTime() >= deadlineNanos) {
                return SearchAttempt.failure(TIMEOUT, true);
            }
            URL endpointUrl = endpoint.toURL();
            URLConnection opened = connectionFactory.open(endpointUrl);
            if (!(opened instanceof HttpsURLConnection)) {
                return SearchAttempt.failure(BLOCKED, false);
            }
            connection = (HttpsURLConnection) opened;
            register(connection, requestId);
            if (isCancelled(requestId)) {
                return SearchAttempt.failure(CANCELLED, false);
            }
            HttpsURLConnection deadlineConnection = connection;
            deadlineDisconnect = deadlineExecutor.schedule(
                () -> {
                    deadlineTriggered.set(true);
                    disconnect(deadlineConnection);
                },
                remainingDeadlineMillis(deadlineNanos, System.nanoTime()),
                TimeUnit.MILLISECONDS
            );
            connection.setInstanceFollowRedirects(false);
            if (connection.getInstanceFollowRedirects()) {
                return SearchAttempt.failure(BLOCKED, false);
            }
            connection.setRequestMethod("GET");
            connection.setConnectTimeout(boundedTimeout(CONNECT_TIMEOUT_MS, deadlineNanos));
            connection.setReadTimeout(boundedTimeout(READ_TIMEOUT_MS, deadlineNanos));
            connection.setUseCaches(false);
            connection.setDefaultUseCaches(false);
            connection.setAllowUserInteraction(false);
            connection.setRequestProperty(
                "Accept",
                "bing".equals(engine)
                    ? "application/rss+xml,application/xml;q=0.9,text/xml;q=0.8"
                    : "text/html,application/xhtml+xml;q=0.9"
            );
            connection.setRequestProperty("Accept-Encoding", "identity");
            connection.setRequestProperty("User-Agent", "KnoteAndroid/0.1");
            connection.setRequestProperty("Cache-Control", "no-store");
            connection.setRequestProperty("Connection", "close");
            connection.setRequestProperty("DNT", "1");
            if (deadlineExpired(deadlineNanos, deadlineTriggered)) {
                return SearchAttempt.failure(TIMEOUT, true);
            }

            int status = connection.getResponseCode();
            responseStatus = status;
            if (isCancelled(requestId)) {
                return SearchAttempt.failure(CANCELLED, false, status, -1L);
            }
            if (deadlineExpired(deadlineNanos, deadlineTriggered)) {
                return SearchAttempt.failure(TIMEOUT, true, status, -1L);
            }
            if (status >= 300 && status < 400) {
                closeQuietly(connection.getErrorStream());
                if (deadlineExpired(deadlineNanos, deadlineTriggered)) {
                    return SearchAttempt.failure(TIMEOUT, true, status, -1L);
                }
                return SearchAttempt.failure(BLOCKED, false, status, retryAfterMillis(connection));
            }
            if (status != HttpURLConnection.HTTP_OK) {
                closeQuietly(connection.getErrorStream());
                if (deadlineExpired(deadlineNanos, deadlineTriggered)) {
                    return SearchAttempt.failure(TIMEOUT, true, status, -1L);
                }
                return httpFailure(status, retryAfterMillis(connection));
            }
            if (!matchesEndpoint(connection, endpoint) || !"GET".equals(connection.getRequestMethod())) {
                return SearchAttempt.failure(BLOCKED, false, status, -1L);
            }
            String contentType = connection.getHeaderField("Content-Type");
            if (contentType == null || !isExpectedContentType(engine, contentType)) {
                return SearchAttempt.failure(INVALID_CONTENT, false, status, -1L);
            }
            String contentEncoding = connection.getHeaderField("Content-Encoding");
            if (contentEncoding != null && !contentEncoding.trim().equalsIgnoreCase("identity")) {
                return SearchAttempt.failure(INVALID_CONTENT, false, status, -1L);
            }
            String transferEncoding = connection.getHeaderField("Transfer-Encoding");
            if (
                transferEncoding != null &&
                !transferEncoding.trim().equalsIgnoreCase("chunked") &&
                !transferEncoding.trim().equalsIgnoreCase("identity")
            ) {
                return SearchAttempt.failure(INVALID_CONTENT, false, status, -1L);
            }
            String contentLengthHeader = connection.getHeaderField("Content-Length");
            long declaredLength = parseContentLength(contentLengthHeader);
            if (declaredLength == CONTENT_LENGTH_INVALID) {
                return SearchAttempt.failure(INVALID_CONTENT, false, status, -1L);
            }
            if (declaredLength > MAX_RESPONSE_BYTES) {
                return SearchAttempt.failure(RESPONSE_TOO_LARGE, false, status, -1L);
            }
            if (contentLengthHeader != null && transferEncoding != null) {
                return SearchAttempt.failure(INVALID_CONTENT, false, status, -1L);
            }
            if (connection.getHeaderField("Content-Range") != null) {
                return SearchAttempt.failure(INVALID_CONTENT, false, status, -1L);
            }

            byte[] body;
            try (InputStream input = connection.getInputStream()) {
                if (input == null) {
                    return SearchAttempt.failure(INVALID_CONTENT, false, status, -1L);
                }
                body = readBounded(input, deadlineNanos, requestId);
            }
            if (isCancelled(requestId)) {
                return SearchAttempt.failure(CANCELLED, false, status, -1L);
            }
            if (deadlineExpired(deadlineNanos, deadlineTriggered)) {
                return SearchAttempt.failure(TIMEOUT, true, status, -1L);
            }
            SearchParser.ParseOutcome parsed = SearchParser.parseResponse(engine, decodeUtf8(body), max);
            if (isCancelled(requestId)) {
                return SearchAttempt.failure(CANCELLED, false, status, -1L);
            }
            if (deadlineExpired(deadlineNanos, deadlineTriggered)) {
                return SearchAttempt.failure(TIMEOUT, true, status, -1L);
            }
            if (parsed.blocked) {
                return SearchAttempt.failure(BLOCKED, false, status, -1L);
            }
            return parsed.valid
                ? SearchAttempt.success(parsed.results, status)
                : SearchAttempt.failure(PARSER_ERROR, false, status, -1L);
        } catch (ResponseTooLargeException exception) {
            if (isCancelled(requestId)) {
                return SearchAttempt.failure(CANCELLED, false, responseStatus, -1L);
            }
            if (deadlineExpired(deadlineNanos, deadlineTriggered)) {
                return SearchAttempt.failure(TIMEOUT, true, responseStatus, -1L);
            }
            return SearchAttempt.failure(RESPONSE_TOO_LARGE, false, responseStatus, -1L);
        } catch (SearchTimeoutException | SocketTimeoutException exception) {
            return isCancelled(requestId)
                ? SearchAttempt.failure(CANCELLED, false, responseStatus, -1L)
                : SearchAttempt.failure(TIMEOUT, true, responseStatus, -1L);
        } catch (InvalidContentException exception) {
            if (isCancelled(requestId)) {
                return SearchAttempt.failure(CANCELLED, false, responseStatus, -1L);
            }
            if (deadlineExpired(deadlineNanos, deadlineTriggered)) {
                return SearchAttempt.failure(TIMEOUT, true, responseStatus, -1L);
            }
            return SearchAttempt.failure(INVALID_CONTENT, false, responseStatus, -1L);
        } catch (IOException | RuntimeException exception) {
            if (isCancelled(requestId)) {
                return SearchAttempt.failure(CANCELLED, false, responseStatus, -1L);
            }
            return deadlineExpired(deadlineNanos, deadlineTriggered)
                ? SearchAttempt.failure(TIMEOUT, true, responseStatus, -1L)
                : SearchAttempt.failure(NETWORK_ERROR, true, responseStatus, -1L);
        } catch (OutOfMemoryError error) {
            return SearchAttempt.failure(RESPONSE_TOO_LARGE, false, responseStatus, -1L);
        } finally {
            if (deadlineDisconnect != null) {
                deadlineDisconnect.cancel(false);
            }
            if (connection != null) {
                unregister(connection, requestId);
                disconnect(connection);
            }
        }
    }

    boolean isCancelled(String requestId) {
        synchronized (requestLock) {
            RequestState state = requests.get(requestId);
            return state == null || state.cancelled;
        }
    }

    private void register(HttpsURLConnection connection, String requestId) {
        synchronized (requestLock) {
            RequestState state = requests.get(requestId);
            if (state == null || state.cancelled) {
                connection.disconnect();
                return;
            }
            state.connections.add(connection);
        }
    }

    private void unregister(HttpsURLConnection connection, String requestId) {
        synchronized (requestLock) {
            RequestState state = requests.get(requestId);
            if (state != null) {
                state.connections.remove(connection);
            }
        }
    }

    private static void disconnectAll(List<HttpsURLConnection> connections) {
        for (HttpsURLConnection connection : connections) {
            disconnect(connection);
        }
    }

    private static void disconnect(HttpsURLConnection connection) {
        if (connection == null) {
            return;
        }
        try {
            connection.disconnect();
        } catch (RuntimeException ignored) {}
    }

    private static JSObject toJsResponse(SearchAttempt attempt, String engine, String requestId) {
        JSArray results = new JSArray();
        for (SearchParser.Result result : attempt.results) {
            results.put(
                new JSObject()
                    .put("title", result.title)
                    .put("url", result.url)
                    .put("snippet", result.snippet)
            );
        }
        JSObject response = new JSObject()
            .put("ok", attempt.ok)
            .put("requestId", requestId)
            .put("results", results);
        if (engine != null && ENGINES.contains(engine)) {
            response.put("engine", engine);
        }
        if (!attempt.ok) {
            response
                .put("code", attempt.code)
                .put("error", publicError(attempt.code))
                .put("retryable", attempt.retryable);
        }
        if (attempt.status >= 100 && attempt.status <= 599) {
            JSObject rate = new JSObject().put("status", attempt.status);
            if (attempt.retryAfterMs >= 0) {
                rate.put("retryAfterMs", attempt.retryAfterMs);
            }
            response.put("status", attempt.status);
            response.put("rate", rate);
        }
        return response;
    }

    static JSObject invalidInputResponse(String requestId, String engine) {
        String safeRequestId = isValidRequestId(requestId) ? requestId : "";
        String safeEngine = engine != null && ENGINES.contains(engine) ? engine : null;
        String code = engine != null && !ENGINES.contains(engine) ? INVALID_ENGINE : INVALID_INPUT;
        return toJsResponse(SearchAttempt.failure(code, false), safeEngine, safeRequestId);
    }

    static JSObject unavailableResponse(String requestId, String engine) {
        String safeRequestId = isValidRequestId(requestId) ? requestId : "";
        String safeEngine = engine != null && ENGINES.contains(engine) ? engine : null;
        return toJsResponse(SearchAttempt.failure(NETWORK_ERROR, true), safeEngine, safeRequestId);
    }

    static JSObject cancelledResponse(String requestId, String engine) {
        String safeRequestId = isValidRequestId(requestId) ? requestId : "";
        String safeEngine = engine != null && ENGINES.contains(engine) ? engine : null;
        return toJsResponse(SearchAttempt.failure(CANCELLED, false), safeEngine, safeRequestId);
    }

    private static String publicError(String code) {
        switch (code) {
            case CANCELLED:
                return "cancelled";
            case NETWORK_ERROR:
                return "network";
            case TIMEOUT:
                return "timeout";
            case RATE_LIMITED:
                return "rate_limited";
            case UPSTREAM_ERROR:
                return "upstream_error";
            case HTTP_ERROR:
                return "http_error";
            case BLOCKED:
                return "blocked";
            case INVALID_CONTENT:
                return "invalid_content";
            case RESPONSE_TOO_LARGE:
                return "too_large";
            case PARSER_ERROR:
                return "parser_error";
            case INVALID_ENGINE:
                return "bad_engine";
            case INVALID_INPUT:
            default:
                return "invalid_input";
        }
    }

    static SearchAttempt httpFailure(int status, long retryAfterMs) {
        if (status == 429) {
            return SearchAttempt.failure(RATE_LIMITED, true, status, retryAfterMs);
        }
        if (status == 408 || status == 425 || status == 500 || status == 502 || status == 503 || status == 504) {
            return SearchAttempt.failure(UPSTREAM_ERROR, true, status, retryAfterMs);
        }
        if (status == 401 || status == 403) {
            return SearchAttempt.failure(BLOCKED, false, status, retryAfterMs);
        }
        return SearchAttempt.failure(HTTP_ERROR, false, status, retryAfterMs);
    }

    private static long retryAfterMillis(HttpURLConnection connection) {
        String value = connection.getHeaderField("Retry-After");
        if (value == null || value.length() > 128 || value.indexOf('\r') >= 0 || value.indexOf('\n') >= 0) {
            return -1;
        }
        String trimmed = value.trim();
        try {
            long seconds = Long.parseLong(trimmed);
            if (seconds < 0) {
                return -1;
            }
            return Math.min(120_000L, seconds > 120L ? 120_000L : seconds * 1000L);
        } catch (NumberFormatException ignored) {
            long timestamp = connection.getHeaderFieldDate("Retry-After", -1L);
            if (timestamp < 0) {
                return -1;
            }
            return Math.min(120_000L, Math.max(0L, timestamp - System.currentTimeMillis()));
        }
    }

    static URI buildEndpoint(String engine, String query, int max, String region) {
        String encodedQuery = encode(query);
        switch (engine) {
            case "bing": {
                String country = region.isEmpty() ? "" : region.substring(0, 2);
                String parameters = "format=rss&q=" + encodedQuery + "&count=" + max;
                if (!country.isEmpty()) {
                    parameters += "&cc=" + encode(country);
                }
                return URI.create("https://www.bing.com/search?" + parameters);
            }
            case "duckduckgo": {
                String parameters = "q=" + encodedQuery;
                if (!region.isEmpty()) {
                    parameters += "&kl=" + encode(region);
                }
                return URI.create("https://html.duckduckgo.com/html/?" + parameters);
            }
            case "mojeek": {
                String country = region.isEmpty() ? "" : region.substring(0, 2);
                String parameters = "q=" + encodedQuery;
                if (!country.isEmpty()) {
                    parameters += "&reg=" + encode(country);
                }
                return URI.create("https://www.mojeek.com/search?" + parameters);
            }
            default:
                throw new IllegalArgumentException("Unsupported engine");
        }
    }

    private static void validateEndpoint(String engine, URI endpoint) throws KnoteException {
        String expectedHost;
        String expectedPath;
        String queryPrefix;
        switch (engine) {
            case "bing":
                expectedHost = "www.bing.com";
                expectedPath = "/search";
                queryPrefix = "format=rss&q=";
                break;
            case "duckduckgo":
                expectedHost = "html.duckduckgo.com";
                expectedPath = "/html/";
                queryPrefix = "q=";
                break;
            case "mojeek":
                expectedHost = "www.mojeek.com";
                expectedPath = "/search";
                queryPrefix = "q=";
                break;
            default:
                throw new KnoteException(ErrorCodes.TYPE_MISMATCH, "Unsupported search engine");
        }
        String rawQuery = endpoint.getRawQuery();
        if (
            !"https".equals(endpoint.getScheme()) ||
            !expectedHost.equals(endpoint.getHost()) ||
            !expectedPath.equals(endpoint.getPath()) ||
            rawQuery == null ||
            !rawQuery.startsWith(queryPrefix) ||
            endpoint.getPort() != -1 ||
            endpoint.getUserInfo() != null ||
            endpoint.getFragment() != null
        ) {
            throw new KnoteException(ErrorCodes.IO_ERROR, "Search endpoint validation failed");
        }
        if (endpoint.toASCIIString().length() > 4096) {
            throw new KnoteException(ErrorCodes.TYPE_MISMATCH, "Search request is too large");
        }
    }

    private static boolean matchesEndpoint(HttpsURLConnection connection, URI endpoint) {
        URL finalUrl = connection.getURL();
        return finalUrl != null &&
            "https".equals(finalUrl.getProtocol()) &&
            endpoint.getHost().equals(finalUrl.getHost()) &&
            endpoint.getPath().equals(finalUrl.getPath()) &&
            finalUrl.getPort() == -1 &&
            endpoint.getRawQuery().equals(finalUrl.getQuery()) &&
            finalUrl.getRef() == null &&
            finalUrl.getUserInfo() == null;
    }

    private byte[] readBounded(InputStream input, long deadlineNanos, String requestId) throws IOException {
        if (input == null) {
            throw new InvalidContentException();
        }
        try (ByteArrayOutputStream output = new ByteArrayOutputStream(32 * 1024)) {
            byte[] buffer = new byte[8192];
            int total = 0;
            int count;
            while (true) {
                if (isCancelled(requestId)) {
                    throw new IOException("Search request was cancelled");
                }
                count = input.read(buffer);
                if (count == -1) {
                    break;
                }
                if (count == 0) {
                    continue;
                }
                if (System.nanoTime() > deadlineNanos) {
                    throw new SearchTimeoutException();
                }
                if (count > MAX_RESPONSE_BYTES - total) {
                    throw new ResponseTooLargeException();
                }
                total += count;
                output.write(buffer, 0, count);
            }
            return output.toByteArray();
        }
    }

    private static String decodeUtf8(byte[] body) throws IOException {
        try {
            return StandardCharsets.UTF_8.newDecoder()
                .onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT)
                .decode(ByteBuffer.wrap(body))
                .toString();
        } catch (CharacterCodingException exception) {
            throw new InvalidContentException();
        }
    }

    private static int boundedTimeout(int preferred, long deadlineNanos) throws IOException {
        long remainingNanos = deadlineNanos - System.nanoTime();
        if (remainingNanos <= 0) {
            throw new SearchTimeoutException();
        }
        long remainingMillis = Math.max(1L, remainingNanos / 1_000_000L);
        return (int) Math.min(preferred, Math.min(Integer.MAX_VALUE, remainingMillis));
    }

    static long deadlineAfterMillis(long nowNanos, int timeoutMillis) {
        long durationNanos = timeoutMillis * 1_000_000L;
        return nowNanos > Long.MAX_VALUE - durationNanos ? Long.MAX_VALUE : nowNanos + durationNanos;
    }

    private static long remainingDeadlineMillis(long deadlineNanos, long nowNanos) throws SearchTimeoutException {
        long remainingNanos = deadlineNanos - nowNanos;
        if (remainingNanos <= 0) {
            throw new SearchTimeoutException();
        }
        return Math.max(1L, (remainingNanos + 999_999L) / 1_000_000L);
    }

    private static boolean deadlineExpired(long deadlineNanos, AtomicBoolean deadlineTriggered) {
        return deadlineTriggered.get() || System.nanoTime() >= deadlineNanos;
    }

    private static void validateQuery(String query) throws KnoteException {
        if (query == null) {
            throw new KnoteException(ErrorCodes.TYPE_MISMATCH, "Invalid search query");
        }
        try {
            if (
                query.trim().isEmpty() ||
                !query.equals(query.trim()) ||
                !Normalizer.isNormalized(query, Normalizer.Form.NFC) ||
                query.codePointCount(0, query.length()) > MAX_QUERY_CODE_POINTS
            ) {
                throw new KnoteException(ErrorCodes.TYPE_MISMATCH, "Invalid search query");
            }
        } catch (IllegalArgumentException exception) {
            throw new KnoteException(ErrorCodes.TYPE_MISMATCH, "Invalid search query");
        }
        boolean hasVisibleContent = false;
        for (int offset = 0; offset < query.length();) {
            char unit = query.charAt(offset);
            if (Character.isHighSurrogate(unit)) {
                if (offset + 1 >= query.length() || !Character.isLowSurrogate(query.charAt(offset + 1))) {
                    throw new KnoteException(ErrorCodes.TYPE_MISMATCH, "Invalid search query");
                }
            } else if (Character.isLowSurrogate(unit)) {
                throw new KnoteException(ErrorCodes.TYPE_MISMATCH, "Invalid search query");
            }
            int codePoint = query.codePointAt(offset);
            if (PathPolicy.isForbiddenCodePoint(codePoint) || codePoint == 0xfffd) {
                throw new KnoteException(ErrorCodes.TYPE_MISMATCH, "Invalid search query");
            }
            boolean whitespace = Character.isWhitespace(codePoint) || Character.isSpaceChar(codePoint);
            if ((offset == 0 || offset + Character.charCount(codePoint) == query.length()) && whitespace) {
                throw new KnoteException(ErrorCodes.TYPE_MISMATCH, "Invalid search query");
            }
            hasVisibleContent |= !whitespace;
            offset += Character.charCount(codePoint);
        }
        if (!hasVisibleContent) {
            throw new KnoteException(ErrorCodes.TYPE_MISMATCH, "Invalid search query");
        }
    }

    private static String validateRegion(String region) throws KnoteException {
        if (region == null || region.isEmpty()) {
            return "";
        }
        String normalized = region.toLowerCase(Locale.ROOT);
        if (!region.equals(normalized)) {
            throw new KnoteException(ErrorCodes.TYPE_MISMATCH, "Search region must be lowercase");
        }
        if (!REGION.matcher(normalized).matches()) {
            throw new KnoteException(ErrorCodes.TYPE_MISMATCH, "Invalid search region");
        }
        return normalized;
    }

    private static boolean isExpectedContentType(String engine, String contentType) {
        if (contentType.length() > 256 || contentType.indexOf('\r') >= 0 || contentType.indexOf('\n') >= 0) {
            return false;
        }
        String normalized = contentType.toLowerCase(Locale.ROOT).replace(" ", "").replace("\t", "");
        String mediaType;
        if ("bing".equals(engine)) {
            if (
                !normalized.equals("application/rss+xml") &&
                !normalized.startsWith("application/rss+xml;") &&
                !normalized.equals("application/xml") &&
                !normalized.startsWith("application/xml;") &&
                !normalized.equals("text/xml") &&
                !normalized.startsWith("text/xml;")
            ) {
                return false;
            }
        } else if (!normalized.equals("text/html") && !normalized.startsWith("text/html;")) {
            return false;
        }
        int separator = normalized.indexOf(';');
        mediaType = separator < 0 ? normalized : normalized.substring(0, separator);
        String parameters = separator < 0 ? "" : normalized.substring(separator + 1);
        if (parameters.isEmpty()) {
            return true;
        }
        String charset = null;
        for (String parameter : parameters.split(";", -1)) {
            if (parameter.isEmpty()) {
                return false;
            }
            int equals = parameter.indexOf('=');
            if (equals <= 0 || equals == parameter.length() - 1) {
                return false;
            }
            String name = parameter.substring(0, equals);
            String value = parameter.substring(equals + 1).replace("\"", "").replace("'", "");
            if (!"charset".equals(name) || charset != null) {
                return false;
            }
            charset = value;
        }
        return !mediaType.isEmpty() && ("utf-8".equals(charset) || "utf8".equals(charset));
    }

    private static long parseContentLength(String value) {
        if (value == null) {
            return CONTENT_LENGTH_MISSING;
        }
        if (value.length() > 32 || value.indexOf(',') >= 0) {
            return CONTENT_LENGTH_INVALID;
        }
        String trimmed = value.trim();
        if (trimmed.isEmpty()) {
            return CONTENT_LENGTH_INVALID;
        }
        for (int index = 0; index < trimmed.length(); index++) {
            char character = trimmed.charAt(index);
            if (character < '0' || character > '9') {
                return CONTENT_LENGTH_INVALID;
            }
        }
        try {
            return Long.parseLong(trimmed);
        } catch (NumberFormatException exception) {
            return CONTENT_LENGTH_INVALID;
        }
    }

    static boolean isValidRequestId(String requestId) {
        return requestId != null && REQUEST_ID.matcher(requestId).matches();
    }

    @FunctionalInterface
    interface ConnectionFactory {
        URLConnection open(URL endpoint) throws IOException;
    }

    private static String encode(String value) {
        try {
            return URLEncoder.encode(value, StandardCharsets.UTF_8.name()).replace("+", "%20");
        } catch (IllegalArgumentException | UnsupportedEncodingException exception) {
            throw new IllegalStateException(exception);
        }
    }

    private static void closeQuietly(InputStream input) {
        if (input == null) {
            return;
        }
        try {
            input.close();
        } catch (IOException ignored) {}
    }

    private static void runCancellation(Runnable cancellation) {
        if (cancellation == null) {
            return;
        }
        try {
            cancellation.run();
        } catch (RuntimeException ignored) {}
    }

    static final class SearchAttempt {
        final boolean ok;
        final List<SearchParser.Result> results;
        final String code;
        final boolean retryable;
        final int status;
        final long retryAfterMs;

        private SearchAttempt(
            boolean ok,
            List<SearchParser.Result> results,
            String code,
            boolean retryable,
            int status,
            long retryAfterMs
        ) {
            this.ok = ok;
            this.results = results;
            this.code = code;
            this.retryable = retryable;
            this.status = status;
            this.retryAfterMs = retryAfterMs;
        }

        static SearchAttempt success(List<SearchParser.Result> results, int status) {
            return new SearchAttempt(true, results, "", false, status, -1L);
        }

        static SearchAttempt failure(String code, boolean retryable) {
            return failure(code, retryable, 0, -1L);
        }

        static SearchAttempt failure(String code, boolean retryable, int status, long retryAfterMs) {
            return new SearchAttempt(false, Collections.emptyList(), code, retryable, status, retryAfterMs);
        }
    }

    private static final class RequestState {
        final Set<HttpsURLConnection> connections = new HashSet<>();
        Runnable queuedCancellation;
        boolean cancelled;
        boolean running;

        RequestState(Runnable queuedCancellation) {
            this.queuedCancellation = queuedCancellation;
        }
    }

    private static final class ResponseTooLargeException extends IOException {}

    private static final class SearchTimeoutException extends IOException {}

    private static final class InvalidContentException extends IOException {}
}
