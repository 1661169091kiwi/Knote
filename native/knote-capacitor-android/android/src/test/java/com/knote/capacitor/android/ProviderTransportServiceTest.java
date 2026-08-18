package com.knote.capacitor.android;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.SocketTimeoutException;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.cert.Certificate;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import javax.net.ssl.HttpsURLConnection;
import javax.net.ssl.SSLPeerUnverifiedException;
import org.junit.Test;

public class ProviderTransportServiceTest {
    @Test
    public void preparesOnlyBoundedHttpsJsonPosts() throws Exception {
        ProviderTransportService.PreparedRequest request = ProviderTransportService.prepare(
            "https://provider.example:8443/v1/messages?version=1",
            "POST",
            Map.of("Authorization", "Bearer secret", "Content-Type", "application/json"),
            "{\"message\":\"ok\"}",
            999_999,
            999_999
        );

        assertEquals("https", request.endpoint.getScheme());
        assertEquals("Bearer secret", request.headers.get("authorization"));
        assertEquals("application/json", request.headers.get("content-type"));
        assertEquals("{\"message\":\"ok\"}", new String(request.body, StandardCharsets.UTF_8));
        assertEquals(ProviderTransportService.DEFAULT_CONNECT_TIMEOUT_MS, request.connectTimeout);
        assertEquals(ProviderTransportService.DEFAULT_READ_TIMEOUT_MS, request.readTimeout);
    }

    @Test
    public void rejectsNonHttpsUserInfoNonPostAndInvalidJson() {
        assertInvalid("http://provider.example/v1", "POST", Map.of(), "{}");
        assertInvalid("https://user:secret@provider.example/v1", "POST", Map.of(), "{}");
        assertInvalid("https://provider.example/v1#fragment", "POST", Map.of(), "{}");
        assertInvalid("https://provider.example:65536/v1", "POST", Map.of(), "{}");
        assertInvalid("https://provider.example/v1", "GET", Map.of(), "{}");
        assertInvalid("https://provider.example/v1", "POST", Map.of(), "[]");
        assertInvalid("https://provider.example/v1", "POST", Map.of(), "{} trailing");
        assertInvalid("https://provider.example/v1", "POST", Map.of(), "{\"number\":1\u0661}");
    }

    @Test
    public void rejectsHeaderInjectionManagedHeadersAndUtf8Overflow() {
        Map<String, String> injected = new LinkedHashMap<>();
        injected.put("Authorization", "Bearer safe\r\nX-Injected: yes");
        assertInvalid("https://provider.example/v1", "POST", injected, "{}");
        assertInvalid("https://provider.example/v1", "POST", Map.of("Accept-Encoding", "gzip"), "{}");
        assertInvalid("https://provider.example/v1", "POST", Map.of("Content-Encoding", "gzip"), "{}");
        assertInvalid("https://provider.example/v1", "POST", Map.of("Authorization", "Bearer safe\r\n"), "{}");
        KnoteException oversized = assertThrows(
            KnoteException.class,
            () -> ProviderTransportService.encodeUtf8Bounded("\u20ac\u20ac\u20ac", 8)
        );
        KnoteException invalidUnicode = assertThrows(
            KnoteException.class,
            () -> ProviderTransportService.encodeUtf8Bounded("\ud800", 8)
        );
        assertEquals(ErrorCodes.PROVIDER_REQUEST_TOO_LARGE, oversized.getCode());
        assertEquals(ErrorCodes.PROVIDER_INVALID_INPUT, invalidUnicode.getCode());
    }

    @Test
    public void cancellationIsScopedToOneProviderRequest() throws Exception {
        ProviderTransportService service = new ProviderTransportService();
        String first = "provider-first-000001";
        String second = "provider-second-00001";
        AtomicInteger firstSettled = new AtomicInteger();
        AtomicInteger secondSettled = new AtomicInteger();
        service.beginRequest(first, firstSettled::incrementAndGet);
        service.beginRequest(second, secondSettled::incrementAndGet);

        assertTrue(service.cancelRequest(first));
        assertEquals(1, firstSettled.get());
        assertEquals(0, secondSettled.get());
        assertTrue(service.isCancelled(first));
        assertFalse(service.isCancelled(second));
        assertFalse(service.cancelRequest(first));
        assertFalse(service.cancelRequest("provider-unknown-001"));

        assertTrue(service.startRequest(second));
        assertTrue(service.cancelRequest(second));
        assertEquals(0, secondSettled.get());

        service.finishRequest(first);
        service.finishRequest(second);
    }

    @Test
    public void responseReaderAcceptsUtf8AndRejectsMoreThanEightMib() throws Exception {
        ProviderTransportService service = new ProviderTransportService();
        String requestId = "provider-reader-00001";
        service.beginRequest(requestId, () -> {});
        long deadline = ProviderTransportService.deadlineAfterMillis(System.nanoTime(), 60_000);
        assertEquals(
            "{\"ok\":true}",
            service.readBoundedUtf8(
                new ByteArrayInputStream("{\"ok\":true}".getBytes(StandardCharsets.UTF_8)),
                requestId,
                null,
                deadline
            )
        );
        assertThrows(
            IOException.class,
            () -> service.readBoundedUtf8(new OversizedInputStream(), requestId, null, deadline)
        );
        service.finishRequest(requestId);
    }

    @Test
    public void responseDeadlineUsesMonotonicAbsoluteRemainingTime() throws Exception {
        long now = 9_000_000_000L;
        long deadline = ProviderTransportService.deadlineAfterMillis(now, 1_500);

        assertEquals(now + 1_500_000_000L, deadline);
        assertEquals(1_500, ProviderTransportService.remainingReadTimeoutMillis(deadline, now));
        assertEquals(1, ProviderTransportService.remainingReadTimeoutMillis(deadline, deadline - 1));
        assertThrows(
            SocketTimeoutException.class,
            () -> ProviderTransportService.remainingReadTimeoutMillis(deadline, deadline)
        );
        assertThrows(
            SocketTimeoutException.class,
            () -> ProviderTransportService.remainingReadTimeoutMillis(deadline, deadline + 1)
        );
        assertEquals(135_000, ProviderTransportService.combinedRequestTimeoutMillis(15_000, 120_000));
        assertEquals(Integer.MAX_VALUE, ProviderTransportService.combinedRequestTimeoutMillis(Integer.MAX_VALUE, 1));
    }

    @Test
    public void providerDeadlineStartsBeforeConnectionAndUpload() throws Exception {
        BlockingHttpsURLConnection connection = new BlockingHttpsURLConnection();
        ProviderTransportService service = new ProviderTransportService(endpoint -> connection);
        String requestId = "provider-upload-00001";
        try {
            ProviderTransportService.PreparedRequest request = ProviderTransportService.prepare(
                "https://provider.example/v1/messages",
                "POST",
                Map.of("Content-Type", "application/json"),
                "{\"message\":\"blocked\"}",
                20,
                20
            );
            service.beginRequest(requestId, () -> {});
            assertTrue(service.startRequest(requestId));
            long startedAt = System.nanoTime();

            KnoteException timeout = assertThrows(KnoteException.class, () -> service.request(requestId, request));
            long elapsedMs = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - startedAt);

            assertEquals(ErrorCodes.PROVIDER_TIMEOUT, timeout.getCode());
            assertTrue(connection.outputRequested.await(1, TimeUnit.SECONDS));
            assertTrue(connection.disconnected);
            assertTrue("blocked connection should be interrupted promptly", elapsedMs < 1000);
        } finally {
            service.finishRequest(requestId);
            service.shutdown();
        }
    }

    private static void assertInvalid(String url, String method, Map<String, String> headers, String body) {
        KnoteException exception = assertThrows(
            KnoteException.class,
            () -> ProviderTransportService.prepare(url, method, headers, body, 1000, 1000)
        );
        assertEquals(ErrorCodes.PROVIDER_INVALID_INPUT, exception.getCode());
    }

    private static final class OversizedInputStream extends InputStream {
        private int remaining = ProviderTransportService.MAX_BODY_BYTES + 1;

        @Override
        public int read() {
            if (remaining == 0) {
                return -1;
            }
            remaining--;
            return 'x';
        }

        @Override
        public int read(byte[] buffer, int offset, int length) {
            if (remaining == 0) {
                return -1;
            }
            int count = Math.min(length, remaining);
            remaining -= count;
            return count;
        }
    }

    private static final class BlockingHttpsURLConnection extends HttpsURLConnection {
        private final CountDownLatch outputRequested = new CountDownLatch(1);
        private final CountDownLatch disconnectRequested = new CountDownLatch(1);
        private volatile boolean disconnected;

        private BlockingHttpsURLConnection() throws Exception {
            super(new URL("https://provider.example/v1/messages"));
        }

        @Override
        public OutputStream getOutputStream() throws IOException {
            outputRequested.countDown();
            try {
                if (!disconnectRequested.await(2, TimeUnit.SECONDS)) {
                    throw new IOException("deadline did not disconnect the blocked connection");
                }
            } catch (InterruptedException exception) {
                Thread.currentThread().interrupt();
                throw new IOException("interrupted", exception);
            }
            throw new IOException("connection disconnected");
        }

        @Override
        public void disconnect() {
            disconnected = true;
            disconnectRequested.countDown();
        }

        @Override
        public boolean usingProxy() {
            return false;
        }

        @Override
        public void connect() {}

        @Override
        public String getCipherSuite() {
            return "TLS_FAKE";
        }

        @Override
        public Certificate[] getLocalCertificates() {
            return null;
        }

        @Override
        public Certificate[] getServerCertificates() throws SSLPeerUnverifiedException {
            return null;
        }
    }
}
