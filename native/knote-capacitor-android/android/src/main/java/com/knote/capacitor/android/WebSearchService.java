package com.knote.capacitor.android;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.UnsupportedEncodingException;
import java.net.HttpURLConnection;
import java.net.URI;
import java.net.URL;
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
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.regex.Pattern;
import java.util.concurrent.atomic.AtomicLong;
import javax.net.ssl.HttpsURLConnection;

final class WebSearchService {
    static final int MAX_QUERY_CODE_POINTS = 256;
    static final int MAX_RESULTS = 20;
    static final int MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

    private static final int CONNECT_TIMEOUT_MS = 5000;
    private static final int READ_TIMEOUT_MS = 8000;
    private static final int TOTAL_TIMEOUT_MS = 10_000;
    private static final Pattern REGION = Pattern.compile("^[a-z]{2}(?:-[a-z]{2,3})?$");
    private static final List<String> AUTO_ENGINES = Collections.unmodifiableList(
        Arrays.asList("bing", "duckduckgo", "mojeek")
    );
    private static final Set<String> ENGINES = Collections.unmodifiableSet(
        new HashSet<>(Arrays.asList("auto", "bing", "duckduckgo", "mojeek"))
    );

    private final Object connectionLock = new Object();
    private final Set<HttpsURLConnection> activeConnections = new HashSet<>();
    private final AtomicLong cancellationEpoch = new AtomicLong();

    JSObject search(String query, int max, String engine, String region) throws KnoteException {
        return search(query, max, engine, region, beginRequest());
    }

    long beginRequest() {
        return cancellationEpoch.get();
    }

    JSObject search(String query, int max, String engine, String region, long requestEpoch) throws KnoteException {
        validateQuery(query);
        if (max < 1 || max > MAX_RESULTS) {
            throw new KnoteException(ErrorCodes.TYPE_MISMATCH, "max must be between 1 and " + MAX_RESULTS);
        }
        if (engine == null || !ENGINES.contains(engine)) {
            throw new KnoteException(ErrorCodes.TYPE_MISMATCH, "Unsupported search engine");
        }
        String safeRegion = validateRegion(region);
        long deadlineNanos = System.nanoTime() + (TOTAL_TIMEOUT_MS * 1_000_000L);

        if (!"auto".equals(engine)) {
            return toJsResponse(fetch(engine, query, max, safeRegion, deadlineNanos, requestEpoch), engine);
        }
        SearchAttempt emptySuccess = null;
        String emptyEngine = null;
        for (String candidate : AUTO_ENGINES) {
            if (isCancelled(requestEpoch) || System.nanoTime() >= deadlineNanos) {
                break;
            }
            SearchAttempt attempt = fetch(candidate, query, max, safeRegion, deadlineNanos, requestEpoch);
            if (attempt.ok) {
                if (!attempt.results.isEmpty()) {
                    return toJsResponse(attempt, candidate);
                }
                if (emptySuccess == null) {
                    emptySuccess = attempt;
                    emptyEngine = candidate;
                }
            }
        }
        if (emptySuccess != null) {
            return toJsResponse(emptySuccess, emptyEngine);
        }
        return toJsResponse(SearchAttempt.failure(), "auto");
    }

    void cancelActive() {
        List<HttpsURLConnection> connections;
        synchronized (connectionLock) {
            cancellationEpoch.incrementAndGet();
            connections = new ArrayList<>(activeConnections);
            activeConnections.clear();
        }
        for (HttpsURLConnection connection : connections) {
            try {
                connection.disconnect();
            } catch (RuntimeException ignored) {}
        }
    }

    private SearchAttempt fetch(
        String engine,
        String query,
        int max,
        String region,
        long deadlineNanos,
        long requestEpoch
    ) throws KnoteException {
        URI endpoint;
        try {
            endpoint = buildEndpoint(engine, query, max, region);
        } catch (RuntimeException exception) {
            throw new KnoteException(ErrorCodes.TYPE_MISMATCH, "Search request could not be encoded");
        }
        validateEndpoint(engine, endpoint);

        HttpsURLConnection connection = null;
        try {
            if (isCancelled(requestEpoch) || System.nanoTime() >= deadlineNanos) {
                return SearchAttempt.failure();
            }
            URL endpointUrl = endpoint.toURL();
            java.net.URLConnection opened = endpointUrl.openConnection();
            if (!(opened instanceof HttpsURLConnection)) {
                return SearchAttempt.failure();
            }
            connection = (HttpsURLConnection) opened;
            register(connection, requestEpoch);
            if (isCancelled(requestEpoch)) {
                return SearchAttempt.failure();
            }
            connection.setInstanceFollowRedirects(false);
            if (connection.getInstanceFollowRedirects()) {
                return SearchAttempt.failure();
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

            int status = connection.getResponseCode();
            if (isCancelled(requestEpoch) || System.nanoTime() > deadlineNanos) {
                return SearchAttempt.failure();
            }
            if (status >= 300 && status < 400) {
                closeQuietly(connection.getErrorStream());
                return SearchAttempt.failure();
            }
            if (status != HttpURLConnection.HTTP_OK) {
                closeQuietly(connection.getErrorStream());
                return SearchAttempt.failure();
            }
            if (!matchesEndpoint(connection, endpoint) || !"GET".equals(connection.getRequestMethod())) {
                return SearchAttempt.failure();
            }
            String contentType = connection.getHeaderField("Content-Type");
            if (contentType == null || !isExpectedContentType(engine, contentType)) {
                return SearchAttempt.failure();
            }
            String contentEncoding = connection.getHeaderField("Content-Encoding");
            if (contentEncoding != null && !contentEncoding.trim().equalsIgnoreCase("identity")) {
                return SearchAttempt.failure();
            }
            String transferEncoding = connection.getHeaderField("Transfer-Encoding");
            if (
                transferEncoding != null &&
                !transferEncoding.trim().equalsIgnoreCase("chunked") &&
                !transferEncoding.trim().equalsIgnoreCase("identity")
            ) {
                return SearchAttempt.failure();
            }
            String contentLengthHeader = connection.getHeaderField("Content-Length");
            if (contentLengthHeader != null && !isAcceptableContentLength(contentLengthHeader)) {
                return SearchAttempt.failure();
            }
            if (contentLengthHeader != null && transferEncoding != null) {
                return SearchAttempt.failure();
            }
            if (connection.getHeaderField("Content-Range") != null) {
                return SearchAttempt.failure();
            }

            byte[] body;
            try (InputStream input = connection.getInputStream()) {
                if (input == null) {
                    return SearchAttempt.failure();
                }
                body = readBounded(input, deadlineNanos);
            }
            if (isCancelled(requestEpoch) || System.nanoTime() > deadlineNanos) {
                return SearchAttempt.failure();
            }
            SearchParser.ParseOutcome parsed = SearchParser.parseResponse(engine, decodeUtf8(body), max);
            return !isCancelled(requestEpoch) && parsed.valid ? SearchAttempt.success(parsed.results) : SearchAttempt.failure();
        } catch (OutOfMemoryError | IOException | RuntimeException exception) {
            return SearchAttempt.failure();
        } finally {
            if (connection != null) {
                unregister(connection);
                try {
                    connection.disconnect();
                } catch (RuntimeException ignored) {}
            }
        }
    }

    private boolean isCancelled(long requestEpoch) {
        return cancellationEpoch.get() != requestEpoch;
    }

    private void register(HttpsURLConnection connection, long requestEpoch) {
        synchronized (connectionLock) {
            activeConnections.add(connection);
            if (isCancelled(requestEpoch)) {
                activeConnections.remove(connection);
                connection.disconnect();
            }
        }
    }

    private void unregister(HttpsURLConnection connection) {
        synchronized (connectionLock) {
            activeConnections.remove(connection);
        }
    }

    private static JSObject toJsResponse(SearchAttempt attempt, String engine) {
        JSArray results = new JSArray();
        for (SearchParser.Result result : attempt.results) {
            results.put(
                new JSObject()
                    .put("title", result.title)
                    .put("url", result.url)
                    .put("snippet", result.snippet)
            );
        }
        return new JSObject().put("ok", attempt.ok).put("engine", engine).put("results", results);
    }

    private static URI buildEndpoint(String engine, String query, int max, String region) {
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

    private static byte[] readBounded(InputStream input, long deadlineNanos) throws IOException {
        if (input == null) {
            throw new IOException("Search response stream is missing");
        }
        try (ByteArrayOutputStream output = new ByteArrayOutputStream(32 * 1024)) {
            byte[] buffer = new byte[8192];
            int total = 0;
            int count;
            while ((count = input.read(buffer)) != -1) {
                if (count == 0) {
                    continue;
                }
                if (System.nanoTime() > deadlineNanos) {
                    throw new IOException("Search request exceeded total timeout");
                }
                if (count > MAX_RESPONSE_BYTES - total) {
                    throw new IOException("Response exceeds limit");
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
            throw new IOException("Search response is not valid UTF-8", exception);
        }
    }

    private static int boundedTimeout(int preferred, long deadlineNanos) throws IOException {
        long remainingNanos = deadlineNanos - System.nanoTime();
        if (remainingNanos <= 0) {
            throw new IOException("Search request exceeded total timeout");
        }
        long remainingMillis = Math.max(1L, remainingNanos / 1_000_000L);
        return (int) Math.min(preferred, Math.min(Integer.MAX_VALUE, remainingMillis));
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

    private static boolean isAcceptableContentLength(String value) {
        if (value.length() > 32 || value.indexOf(',') >= 0) {
            return false;
        }
        try {
            long length = Long.parseLong(value.trim());
            return length >= 0 && length <= MAX_RESPONSE_BYTES;
        } catch (NumberFormatException exception) {
            return false;
        }
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

    private static final class SearchAttempt {
        final boolean ok;
        final List<SearchParser.Result> results;

        private SearchAttempt(boolean ok, List<SearchParser.Result> results) {
            this.ok = ok;
            this.results = results;
        }

        static SearchAttempt success(List<SearchParser.Result> results) {
            return new SearchAttempt(true, results);
        }

        static SearchAttempt failure() {
            return new SearchAttempt(false, Collections.emptyList());
        }
    }
}
