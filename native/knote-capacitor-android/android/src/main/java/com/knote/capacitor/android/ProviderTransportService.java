package com.knote.capacitor.android;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.URI;
import java.net.SocketTimeoutException;
import java.net.URISyntaxException;
import java.net.URL;
import java.net.URLConnection;
import java.nio.ByteBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.ScheduledThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.regex.Pattern;
import javax.net.ssl.HttpsURLConnection;

final class ProviderTransportService {
    static final int MAX_BODY_BYTES = 8 * 1024 * 1024;
    static final int DEFAULT_CONNECT_TIMEOUT_MS = 15_000;
    static final int DEFAULT_READ_TIMEOUT_MS = 120_000;

    private static final int MAX_URL_LENGTH = 16 * 1024;
    private static final int MAX_HEADER_COUNT = 64;
    private static final int MAX_HEADER_NAME_LENGTH = 128;
    private static final int MAX_HEADER_VALUE_LENGTH = 8 * 1024;
    private static final int MAX_HEADER_BYTES = 64 * 1024;
    private static final int MAX_JSON_DEPTH = 128;
    private static final Pattern REQUEST_ID = Pattern.compile("^[A-Za-z0-9_-]{16,128}$");
    private static final Set<String> MANAGED_HEADERS;

    static {
        Set<String> names = new HashSet<>();
        Collections.addAll(
            names,
            "accept-encoding",
            "connection",
            "content-encoding",
            "content-length",
            "expect",
            "host",
            "proxy-connection",
            "te",
            "trailer",
            "transfer-encoding",
            "upgrade"
        );
        MANAGED_HEADERS = Collections.unmodifiableSet(names);
    }

    private final Object requestLock = new Object();
    private final Map<String, RequestState> requests = new HashMap<>();
    private final ConnectionFactory connectionFactory;
    private final ScheduledThreadPoolExecutor deadlineExecutor;

    ProviderTransportService() {
        this(URL::openConnection);
    }

    ProviderTransportService(ConnectionFactory connectionFactory) {
        if (connectionFactory == null) {
            throw new IllegalArgumentException("Provider connection factory is required");
        }
        this.connectionFactory = connectionFactory;
        deadlineExecutor = new ScheduledThreadPoolExecutor(1, runnable -> {
            Thread thread = new Thread(runnable, "knote-provider-deadline");
            thread.setDaemon(true);
            return thread;
        });
        deadlineExecutor.setRemoveOnCancelPolicy(true);
        deadlineExecutor.setExecuteExistingDelayedTasksAfterShutdownPolicy(false);
    }

    void beginRequest(String requestId, Runnable queuedCancellation) throws KnoteException {
        if (!isValidRequestId(requestId)) {
            throw invalid("Invalid provider request identifier");
        }
        if (queuedCancellation == null) {
            throw invalid("Provider cancellation handler is missing");
        }
        synchronized (requestLock) {
            if (requests.containsKey(requestId)) {
                throw invalid("Duplicate provider request identifier");
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

    Response request(
        String requestId,
        PreparedRequest request
    ) throws KnoteException {
        if (request == null) {
            throw invalid("Provider request is missing");
        }
        if (isCancelled(requestId)) {
            throw cancelled();
        }

        HttpsURLConnection connection = null;
        ScheduledFuture<?> deadlineDisconnect = null;
        long requestDeadlineNanos = deadlineAfterMillis(
            System.nanoTime(),
            combinedRequestTimeoutMillis(request.connectTimeout, request.readTimeout)
        );
        long responseDeadlineNanos = Long.MAX_VALUE;
        try {
            URL endpoint = request.endpoint.toURL();
            URLConnection opened = connectionFactory.open(endpoint);
            if (!(opened instanceof HttpsURLConnection)) {
                throw new IOException("Provider endpoint did not open as HTTPS");
            }
            connection = (HttpsURLConnection) opened;
            if (!register(requestId, connection)) {
                throw new RequestCancelledException();
            }
            connection.setInstanceFollowRedirects(false);
            if (connection.getInstanceFollowRedirects()) {
                throw new IOException("Redirects could not be disabled");
            }
            connection.setRequestMethod("POST");
            connection.setConnectTimeout(request.connectTimeout);
            connection.setReadTimeout(request.readTimeout);
            connection.setUseCaches(false);
            connection.setDefaultUseCaches(false);
            connection.setAllowUserInteraction(false);
            connection.setDoInput(true);
            connection.setDoOutput(true);
            connection.setFixedLengthStreamingMode(request.body.length);
            for (Map.Entry<String, String> header : request.headers.entrySet()) {
                connection.setRequestProperty(header.getKey(), header.getValue());
            }
            connection.setRequestProperty("Accept-Encoding", "identity");
            connection.setRequestProperty("Connection", "close");

            // Arm the monotonic request deadline before getOutputStream() can
            // connect or block while uploading the fixed-length body.
            deadlineDisconnect = writeRequestWithDeadline(connection, request.body, requestId, requestDeadlineNanos);
            long responseStartedAt = System.nanoTime();
            responseDeadlineNanos = Math.min(
                requestDeadlineNanos,
                deadlineAfterMillis(responseStartedAt, request.readTimeout)
            );
            int responseTimeout = remainingReadTimeoutMillis(responseDeadlineNanos, responseStartedAt);
            connection.setReadTimeout(responseTimeout);
            HttpsURLConnection deadlineConnection = connection;
            ScheduledFuture<?> responseDeadlineDisconnect = deadlineExecutor.schedule(
                () -> disconnect(deadlineConnection),
                responseTimeout,
                TimeUnit.MILLISECONDS
            );
            deadlineDisconnect.cancel(false);
            deadlineDisconnect = responseDeadlineDisconnect;
            int status = connection.getResponseCode();
            if (System.nanoTime() >= responseDeadlineNanos) {
                throw new SocketTimeoutException("Provider response deadline exceeded");
            }
            if (status < 200 || status > 599) {
                throw new InvalidResponseException();
            }
            if (isCancelled(requestId)) {
                throw new RequestCancelledException();
            }
            String contentEncoding = connection.getHeaderField("Content-Encoding");
            if (
                contentEncoding != null &&
                !contentEncoding.trim().isEmpty() &&
                !"identity".equalsIgnoreCase(contentEncoding.trim())
            ) {
                throw new InvalidResponseException();
            }
            long declaredLength = parseContentLength(connection.getHeaderField("Content-Length"));
            if (declaredLength > MAX_BODY_BYTES) {
                throw new ResponseTooLargeException();
            }
            String contentType = sanitizeContentType(connection.getHeaderField("Content-Type"));
            InputStream responseStream = status >= 400 ? connection.getErrorStream() : connection.getInputStream();
            String responseBody = responseStream == null
                ? ""
                : readBoundedUtf8(responseStream, requestId, connection, responseDeadlineNanos);
            if (isCancelled(requestId)) {
                throw new RequestCancelledException();
            }
            if (System.nanoTime() >= responseDeadlineNanos) {
                throw new SocketTimeoutException("Provider response deadline exceeded");
            }
            return new Response(status, contentType, responseBody);
        } catch (RequestCancelledException exception) {
            throw cancelled();
        } catch (ResponseTooLargeException exception) {
            throw responseTooLarge();
        } catch (InvalidResponseException exception) {
            if (deadlineExpired(requestDeadlineNanos, responseDeadlineNanos)) {
                throw timeout();
            }
            throw invalidResponse();
        } catch (SocketTimeoutException exception) {
            if (isCancelled(requestId)) {
                throw cancelled();
            }
            throw timeout();
        } catch (IOException exception) {
            if (isCancelled(requestId)) {
                throw cancelled();
            }
            if (deadlineExpired(requestDeadlineNanos, responseDeadlineNanos)) {
                throw timeout();
            }
            throw networkError();
        } catch (OutOfMemoryError error) {
            throw responseTooLarge();
        } catch (RuntimeException exception) {
            if (isCancelled(requestId)) {
                throw cancelled();
            }
            if (deadlineExpired(requestDeadlineNanos, responseDeadlineNanos)) {
                throw timeout();
            }
            throw invalidResponse();
        } finally {
            if (deadlineDisconnect != null) {
                deadlineDisconnect.cancel(false);
            }
            if (connection != null) {
                unregister(requestId, connection);
                try {
                    connection.disconnect();
                } catch (RuntimeException ignored) {}
            }
        }
    }

    boolean cancelRequest(String requestId) {
        HttpsURLConnection connection;
        Runnable queuedCancellation;
        synchronized (requestLock) {
            RequestState state = requests.get(requestId);
            if (state == null || state.cancelled) {
                return false;
            }
            state.cancelled = true;
            connection = state.connection;
            state.connection = null;
            queuedCancellation = state.queuedCancellation;
            state.queuedCancellation = null;
        }
        runCancellation(queuedCancellation);
        disconnect(connection);
        return true;
    }

    void cancelAll() {
        List<HttpsURLConnection> connections = new ArrayList<>();
        List<Runnable> queuedCancellations = new ArrayList<>();
        synchronized (requestLock) {
            for (RequestState state : requests.values()) {
                if (state.cancelled) {
                    continue;
                }
                state.cancelled = true;
                if (state.connection != null) {
                    connections.add(state.connection);
                    state.connection = null;
                }
                if (state.queuedCancellation != null) {
                    queuedCancellations.add(state.queuedCancellation);
                    state.queuedCancellation = null;
                }
            }
        }
        for (Runnable cancellation : queuedCancellations) {
            runCancellation(cancellation);
        }
        for (HttpsURLConnection connection : connections) {
            disconnect(connection);
        }
    }

    void shutdown() {
        cancelAll();
        deadlineExecutor.shutdownNow();
    }

    void finishRequest(String requestId) {
        synchronized (requestLock) {
            requests.remove(requestId);
        }
    }

    boolean isCancelled(String requestId) {
        synchronized (requestLock) {
            RequestState state = requests.get(requestId);
            return state == null || state.cancelled;
        }
    }

    static boolean isValidRequestId(String requestId) {
        return requestId != null && REQUEST_ID.matcher(requestId).matches();
    }

    static PreparedRequest prepare(
        String url,
        String method,
        Map<String, String> headers,
        String body,
        int connectTimeout,
        int readTimeout
    ) throws KnoteException {
        if (!"POST".equals(method)) {
            throw invalid("Provider transport permits POST only");
        }
        URI endpoint = validateEndpoint(url);
        byte[] encodedBody = encodeUtf8Bounded(body, MAX_BODY_BYTES);
        if (!JsonValidator.isObject(body)) {
            throw invalid("Provider body must be a valid JSON object");
        }
        Map<String, String> safeHeaders = sanitizeHeaders(headers);
        if (!safeHeaders.containsKey("content-type")) {
            safeHeaders.put("content-type", "application/json; charset=utf-8");
        }
        return new PreparedRequest(
            endpoint,
            Collections.unmodifiableMap(safeHeaders),
            encodedBody,
            boundedTimeout(connectTimeout, DEFAULT_CONNECT_TIMEOUT_MS),
            boundedTimeout(readTimeout, DEFAULT_READ_TIMEOUT_MS)
        );
    }

    static byte[] encodeUtf8Bounded(String value, int maximum) throws KnoteException {
        if (value == null || maximum < 1) {
            throw invalid("Provider request body is invalid");
        }
        if (value.length() > maximum) {
            throw requestTooLarge();
        }
        int bytes = 0;
        for (int index = 0; index < value.length();) {
            char unit = value.charAt(index);
            int codePoint;
            if (Character.isHighSurrogate(unit)) {
                if (index + 1 >= value.length() || !Character.isLowSurrogate(value.charAt(index + 1))) {
                    throw invalid("Provider request is not valid Unicode");
                }
                codePoint = Character.toCodePoint(unit, value.charAt(index + 1));
                index += 2;
            } else if (Character.isLowSurrogate(unit)) {
                throw invalid("Provider request is not valid Unicode");
            } else {
                codePoint = unit;
                index++;
            }
            int width = codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
            if (width > maximum - bytes) {
                throw requestTooLarge();
            }
            bytes += width;
        }
        return value.getBytes(StandardCharsets.UTF_8);
    }

    private static URI validateEndpoint(String value) throws KnoteException {
        if (
            value == null ||
            value.isEmpty() ||
            value.length() > MAX_URL_LENGTH ||
            !value.equals(value.trim()) ||
            value.indexOf('\\') >= 0
        ) {
            throw invalid("Provider URL is invalid");
        }
        for (int index = 0; index < value.length(); index++) {
            char character = value.charAt(index);
            if (character <= 0x20 || character == 0x7f) {
                throw invalid("Provider URL is invalid");
            }
        }
        try {
            URI endpoint = new URI(value);
            if (
                !endpoint.isAbsolute() ||
                endpoint.isOpaque() ||
                !"https".equalsIgnoreCase(endpoint.getScheme()) ||
                endpoint.getRawAuthority() == null ||
                endpoint.getHost() == null ||
                endpoint.getHost().isEmpty() ||
                endpoint.getRawUserInfo() != null ||
                endpoint.getRawFragment() != null ||
                endpoint.getPort() == 0 ||
                endpoint.getPort() > 65_535 ||
                endpoint.getPort() < -1
            ) {
                throw invalid("Provider URL must be an explicit HTTPS URL without user information");
            }
            endpoint.toURL();
            return endpoint;
        } catch (URISyntaxException | IllegalArgumentException | IOException exception) {
            throw invalid("Provider URL is invalid");
        }
    }

    private static Map<String, String> sanitizeHeaders(Map<String, String> headers) throws KnoteException {
        if (headers == null || headers.size() > MAX_HEADER_COUNT) {
            throw invalid("Provider request headers are invalid");
        }
        Map<String, String> output = new LinkedHashMap<>();
        int total = 0;
        for (Map.Entry<String, String> entry : headers.entrySet()) {
            String name = entry.getKey();
            String value = entry.getValue();
            if (
                name == null ||
                name.isEmpty() ||
                name.length() > MAX_HEADER_NAME_LENGTH ||
                value == null ||
                value.length() > MAX_HEADER_VALUE_LENGTH ||
                !isHeaderName(name)
            ) {
                throw invalid("Provider request headers are invalid");
            }
            String normalizedName = name.toLowerCase(Locale.ROOT);
            if (MANAGED_HEADERS.contains(normalizedName) || output.containsKey(normalizedName)) {
                throw invalid("Provider request contains a forbidden or duplicate header");
            }
            for (int index = 0; index < value.length(); index++) {
                char character = value.charAt(index);
                if (character < 0x20 || character > 0x7e) {
                    throw invalid("Provider request header value is invalid");
                }
            }
            String normalizedValue = value.trim();
            total += normalizedName.length() + normalizedValue.length();
            if (total > MAX_HEADER_BYTES) {
                throw invalid("Provider request headers exceeded the size limit");
            }
            output.put(normalizedName, normalizedValue);
        }
        return output;
    }

    private static boolean isHeaderName(String name) {
        for (int index = 0; index < name.length(); index++) {
            char character = name.charAt(index);
            boolean alphaNumeric =
                (character >= 'a' && character <= 'z') ||
                (character >= 'A' && character <= 'Z') ||
                (character >= '0' && character <= '9');
            if (!(alphaNumeric || "!#$%&'*+-.^_`|~".indexOf(character) >= 0)) {
                return false;
            }
        }
        return true;
    }

    private static int boundedTimeout(int requested, int maximum) throws KnoteException {
        if (requested <= 0) {
            throw invalid("Provider timeout must be positive");
        }
        return Math.min(requested, maximum);
    }

    static int combinedRequestTimeoutMillis(int connectTimeout, int readTimeout) {
        long combined = Math.max(1L, (long) connectTimeout) + Math.max(1L, (long) readTimeout);
        return (int) Math.min(Integer.MAX_VALUE, combined);
    }

    private boolean register(String requestId, HttpsURLConnection connection) {
        synchronized (requestLock) {
            RequestState state = requests.get(requestId);
            if (state == null || state.cancelled) {
                return false;
            }
            state.connection = connection;
            return true;
        }
    }

    private void unregister(String requestId, HttpsURLConnection connection) {
        synchronized (requestLock) {
            RequestState state = requests.get(requestId);
            if (state != null && state.connection == connection) {
                state.connection = null;
            }
        }
    }

    ScheduledFuture<?> writeRequestWithDeadline(
        HttpsURLConnection connection,
        byte[] body,
        String requestId,
        long deadlineNanos
    ) throws IOException {
        int remainingTimeout = remainingReadTimeoutMillis(deadlineNanos, System.nanoTime());
        ScheduledFuture<?> deadline = deadlineExecutor.schedule(
            () -> disconnect(connection),
            remainingTimeout,
            TimeUnit.MILLISECONDS
        );
        boolean completed = false;
        try {
            writeRequest(connection, body, requestId);
            completed = true;
            return deadline;
        } finally {
            if (!completed) {
                deadline.cancel(false);
            }
        }
    }

    private void writeRequest(HttpsURLConnection connection, byte[] body, String requestId) throws IOException {
        try (OutputStream output = connection.getOutputStream()) {
            int offset = 0;
            while (offset < body.length) {
                if (isCancelled(requestId)) {
                    throw new RequestCancelledException();
                }
                int count = Math.min(8192, body.length - offset);
                output.write(body, offset, count);
                offset += count;
            }
            output.flush();
        }
    }

    String readBoundedUtf8(
        InputStream input,
        String requestId,
        HttpsURLConnection connection,
        long deadlineNanos
    ) throws IOException {
        try (InputStream source = input; ByteArrayOutputStream output = new ByteArrayOutputStream(32 * 1024)) {
            byte[] buffer = new byte[8192];
            int total = 0;
            while (true) {
                if (isCancelled(requestId)) {
                    throw new RequestCancelledException();
                }
                int remainingTimeout = remainingReadTimeoutMillis(deadlineNanos, System.nanoTime());
                if (connection != null) {
                    connection.setReadTimeout(remainingTimeout);
                }
                int count = source.read(buffer);
                if (System.nanoTime() >= deadlineNanos) {
                    throw new SocketTimeoutException("Provider response deadline exceeded");
                }
                if (count == -1) {
                    break;
                }
                if (count == 0) {
                    continue;
                }
                if (count > MAX_BODY_BYTES - total) {
                    throw new ResponseTooLargeException();
                }
                output.write(buffer, 0, count);
                total += count;
            }
            try {
                return StandardCharsets.UTF_8.newDecoder()
                    .onMalformedInput(CodingErrorAction.REPORT)
                    .onUnmappableCharacter(CodingErrorAction.REPORT)
                    .decode(ByteBuffer.wrap(output.toByteArray()))
                    .toString();
            } catch (CharacterCodingException exception) {
                throw new InvalidResponseException();
            }
        }
    }

    static long deadlineAfterMillis(long nowNanos, int timeoutMillis) {
        long durationNanos = timeoutMillis * 1_000_000L;
        return nowNanos > Long.MAX_VALUE - durationNanos ? Long.MAX_VALUE : nowNanos + durationNanos;
    }

    static int remainingReadTimeoutMillis(long deadlineNanos, long nowNanos) throws SocketTimeoutException {
        long remainingNanos = deadlineNanos - nowNanos;
        if (remainingNanos <= 0) {
            throw new SocketTimeoutException("Provider response deadline exceeded");
        }
        if (remainingNanos >= Integer.MAX_VALUE * 1_000_000L) {
            return Integer.MAX_VALUE;
        }
        return (int) Math.max(1L, (remainingNanos + 999_999L) / 1_000_000L);
    }

    private static boolean deadlineExpired(long requestDeadlineNanos, long responseDeadlineNanos) {
        long now = System.nanoTime();
        return now >= requestDeadlineNanos ||
            (responseDeadlineNanos != Long.MAX_VALUE && now >= responseDeadlineNanos);
    }

    private static String sanitizeContentType(String value) {
        if (value == null || value.length() > 256) {
            return "";
        }
        for (int index = 0; index < value.length(); index++) {
            char character = value.charAt(index);
            if (character < 0x20 || character > 0x7e) {
                return "";
            }
        }
        return value.trim();
    }

    private static long parseContentLength(String value) throws InvalidResponseException {
        if (value == null) {
            return -1L;
        }
        String trimmed = value.trim();
        if (trimmed.isEmpty() || trimmed.length() > 32) {
            throw new InvalidResponseException();
        }
        for (int index = 0; index < trimmed.length(); index++) {
            char character = trimmed.charAt(index);
            if (character < '0' || character > '9') {
                throw new InvalidResponseException();
            }
        }
        try {
            return Long.parseLong(trimmed);
        } catch (NumberFormatException exception) {
            throw new InvalidResponseException();
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

    private static void runCancellation(Runnable cancellation) {
        if (cancellation == null) {
            return;
        }
        try {
            cancellation.run();
        } catch (RuntimeException ignored) {}
    }

    private static KnoteException invalid(String message) {
        return new KnoteException(ErrorCodes.PROVIDER_INVALID_INPUT, message);
    }

    private static KnoteException requestTooLarge() {
        return new KnoteException(ErrorCodes.PROVIDER_REQUEST_TOO_LARGE, "Provider request exceeded the 8 MiB limit");
    }

    private static KnoteException cancelled() {
        return new KnoteException(ErrorCodes.PROVIDER_CANCELLED, "Provider request was cancelled");
    }

    private static KnoteException timeout() {
        return new KnoteException(ErrorCodes.PROVIDER_TIMEOUT, "Provider request timed out");
    }

    private static KnoteException networkError() {
        return new KnoteException(ErrorCodes.PROVIDER_NETWORK_ERROR, "Provider network request failed");
    }

    private static KnoteException responseTooLarge() {
        return new KnoteException(ErrorCodes.PROVIDER_RESPONSE_TOO_LARGE, "Provider response exceeded the 8 MiB limit");
    }

    private static KnoteException invalidResponse() {
        return new KnoteException(ErrorCodes.PROVIDER_INVALID_RESPONSE, "Provider returned an invalid response");
    }

    static final class PreparedRequest {
        final URI endpoint;
        final Map<String, String> headers;
        final byte[] body;
        final int connectTimeout;
        final int readTimeout;

        PreparedRequest(
            URI endpoint,
            Map<String, String> headers,
            byte[] body,
            int connectTimeout,
            int readTimeout
        ) {
            this.endpoint = endpoint;
            this.headers = headers;
            this.body = body;
            this.connectTimeout = connectTimeout;
            this.readTimeout = readTimeout;
        }
    }

    @FunctionalInterface
    interface ConnectionFactory {
        URLConnection open(URL endpoint) throws IOException;
    }

    static final class Response {
        final int status;
        final String contentType;
        final String body;

        Response(int status, String contentType, String body) {
            this.status = status;
            this.contentType = contentType;
            this.body = body;
        }
    }

    private static final class RequestState {
        Runnable queuedCancellation;
        HttpsURLConnection connection;
        boolean cancelled;
        boolean running;

        RequestState(Runnable queuedCancellation) {
            this.queuedCancellation = queuedCancellation;
        }
    }

    private static final class RequestCancelledException extends IOException {}

    private static final class ResponseTooLargeException extends IOException {}

    private static final class InvalidResponseException extends IOException {}

    private static final class JsonValidator {
        private final String input;
        private int index;
        private int depth;

        private JsonValidator(String input) {
            this.input = input;
        }

        static boolean isObject(String input) {
            if (input == null) {
                return false;
            }
            JsonValidator parser = new JsonValidator(input);
            parser.skipWhitespace();
            parser.depth = 1;
            if (!parser.parseObject()) {
                return false;
            }
            parser.skipWhitespace();
            return parser.index == input.length();
        }

        private boolean parseValue() {
            skipWhitespace();
            if (index >= input.length()) {
                return false;
            }
            depth++;
            if (depth > MAX_JSON_DEPTH) {
                depth--;
                return false;
            }
            char character = input.charAt(index);
            boolean valid;
            if (character == '{') {
                valid = parseObject();
            } else if (character == '[') {
                valid = parseArray();
            } else if (character == '"') {
                valid = parseString();
            } else if (character == 't') {
                valid = consume("true");
            } else if (character == 'f') {
                valid = consume("false");
            } else if (character == 'n') {
                valid = consume("null");
            } else {
                valid = parseNumber();
            }
            depth--;
            return valid;
        }

        private boolean parseObject() {
            if (!take('{')) {
                return false;
            }
            skipWhitespace();
            if (take('}')) {
                return true;
            }
            while (true) {
                if (!parseString()) {
                    return false;
                }
                skipWhitespace();
                if (!take(':') || !parseValue()) {
                    return false;
                }
                skipWhitespace();
                if (take('}')) {
                    return true;
                }
                if (!take(',')) {
                    return false;
                }
                skipWhitespace();
            }
        }

        private boolean parseArray() {
            if (!take('[')) {
                return false;
            }
            skipWhitespace();
            if (take(']')) {
                return true;
            }
            while (true) {
                if (!parseValue()) {
                    return false;
                }
                skipWhitespace();
                if (take(']')) {
                    return true;
                }
                if (!take(',')) {
                    return false;
                }
                skipWhitespace();
            }
        }

        private boolean parseString() {
            if (!take('"')) {
                return false;
            }
            while (index < input.length()) {
                char character = input.charAt(index++);
                if (character == '"') {
                    return true;
                }
                if (character < 0x20) {
                    return false;
                }
                if (character != '\\') {
                    continue;
                }
                if (index >= input.length()) {
                    return false;
                }
                char escaped = input.charAt(index++);
                if ("\"\\/bfnrt".indexOf(escaped) >= 0) {
                    continue;
                }
                if (escaped != 'u' || index + 4 > input.length()) {
                    return false;
                }
                for (int offset = 0; offset < 4; offset++) {
                    if (!isHexDigit(input.charAt(index + offset))) {
                        return false;
                    }
                }
                index += 4;
            }
            return false;
        }

        private boolean parseNumber() {
            int start = index;
            take('-');
            if (take('0')) {
                if (index < input.length() && isDigit(input.charAt(index))) {
                    return false;
                }
            } else {
                if (index >= input.length() || input.charAt(index) < '1' || input.charAt(index) > '9') {
                    index = start;
                    return false;
                }
                while (index < input.length() && isDigit(input.charAt(index))) {
                    index++;
                }
            }
            if (take('.')) {
                int digits = index;
                while (index < input.length() && isDigit(input.charAt(index))) {
                    index++;
                }
                if (digits == index) {
                    return false;
                }
            }
            if (index < input.length() && (input.charAt(index) == 'e' || input.charAt(index) == 'E')) {
                index++;
                if (index < input.length() && (input.charAt(index) == '+' || input.charAt(index) == '-')) {
                    index++;
                }
                int digits = index;
                while (index < input.length() && isDigit(input.charAt(index))) {
                    index++;
                }
                if (digits == index) {
                    return false;
                }
            }
            return index > start;
        }

        private static boolean isDigit(char character) {
            return character >= '0' && character <= '9';
        }

        private static boolean isHexDigit(char character) {
            return isDigit(character) ||
                (character >= 'a' && character <= 'f') ||
                (character >= 'A' && character <= 'F');
        }

        private boolean consume(String value) {
            if (!input.regionMatches(index, value, 0, value.length())) {
                return false;
            }
            index += value.length();
            return true;
        }

        private boolean take(char expected) {
            if (index >= input.length() || input.charAt(index) != expected) {
                return false;
            }
            index++;
            return true;
        }

        private void skipWhitespace() {
            while (index < input.length()) {
                char character = input.charAt(index);
                if (character != ' ' && character != '\t' && character != '\r' && character != '\n') {
                    return;
                }
                index++;
            }
        }
    }
}
