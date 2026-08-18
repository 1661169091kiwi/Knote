package com.knote.capacitor.android;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.io.IOException;
import java.io.InputStream;
import java.net.URI;
import java.net.URL;
import java.security.cert.Certificate;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import javax.net.ssl.HttpsURLConnection;
import javax.net.ssl.SSLPeerUnverifiedException;
import org.junit.Test;

public class WebSearchServiceTest {
    @Test
    public void cancellationIsScopedToOneRegisteredRequest() throws Exception {
        WebSearchService service = new WebSearchService();
        String first = "request-first-000001";
        String second = "request-second-00001";
        AtomicInteger firstSettled = new AtomicInteger();
        AtomicInteger secondSettled = new AtomicInteger();
        service.beginRequest(first, firstSettled::incrementAndGet);
        service.beginRequest(second, secondSettled::incrementAndGet);

        assertTrue(service.cancelRequest(first));
        assertEquals(1, firstSettled.get());
        assertEquals(0, secondSettled.get());
        assertTrue(service.isCancelled(first));
        assertFalse(service.isCancelled(second));
        assertFalse(service.cancelRequest("request-unknown-001"));

        assertTrue(service.startRequest(second));
        assertTrue(service.cancelRequest(second));
        assertEquals(0, secondSettled.get());

        service.finishRequest(first);
        service.finishRequest(second);
    }

    @Test
    public void queuedCancellationRemovesTaskAndReleasesBoundedQueueSlot() throws Exception {
        WebSearchService service = new WebSearchService();
        ThreadPoolExecutor executor = BoundedExecutor.create(1, 1);
        String requestId = "request-queued-00001";
        CountDownLatch workerStarted = new CountDownLatch(1);
        CountDownLatch releaseWorker = new CountDownLatch(1);
        CountDownLatch peerFinished = new CountDownLatch(1);
        AtomicBoolean removed = new AtomicBoolean();
        AtomicInteger queuedRuns = new AtomicInteger();
        AtomicInteger settled = new AtomicInteger();
        Runnable queued = () -> {
            if (!service.startRequest(requestId)) {
                return;
            }
            queuedRuns.incrementAndGet();
            service.finishRequest(requestId);
        };
        try {
            executor.execute(() -> await(workerStarted, releaseWorker));
            assertTrue(workerStarted.await(2, TimeUnit.SECONDS));
            service.beginRequest(requestId, () -> {
                removed.set(executor.remove(queued));
                settled.incrementAndGet();
                service.finishRequest(requestId);
            });
            executor.execute(queued);
            assertEquals(0, executor.getQueue().remainingCapacity());

            assertTrue(service.cancelRequest(requestId));
            assertTrue(removed.get());
            assertEquals(1, settled.get());
            assertEquals(1, executor.getQueue().remainingCapacity());
            executor.execute(peerFinished::countDown);
            releaseWorker.countDown();

            assertTrue(peerFinished.await(2, TimeUnit.SECONDS));
            assertEquals(0, queuedRuns.get());
        } finally {
            releaseWorker.countDown();
            executor.shutdownNow();
            assertTrue(executor.awaitTermination(2, TimeUnit.SECONDS));
        }
    }

    @Test
    public void httpFailuresExposeOnlyStableStatusAndRetryability() {
        WebSearchService.SearchAttempt limited = WebSearchService.httpFailure(429, 2500L);
        WebSearchService.SearchAttempt blocked = WebSearchService.httpFailure(403, -1L);
        WebSearchService.SearchAttempt upstream = WebSearchService.httpFailure(503, 1000L);
        WebSearchService.SearchAttempt missing = WebSearchService.httpFailure(404, -1L);

        assertEquals(WebSearchService.RATE_LIMITED, limited.code);
        assertEquals(429, limited.status);
        assertEquals(2500L, limited.retryAfterMs);
        assertTrue(limited.retryable);
        assertEquals(WebSearchService.BLOCKED, blocked.code);
        assertFalse(blocked.retryable);
        assertEquals(WebSearchService.UPSTREAM_ERROR, upstream.code);
        assertTrue(upstream.retryable);
        assertEquals(WebSearchService.HTTP_ERROR, missing.code);
        assertFalse(missing.retryable);
    }

    @Test
    public void mojeekUsesTheConfiguredCountryRegionWithoutChangingItsFixedEndpoint() {
        URI endpoint = WebSearchService.buildEndpoint("mojeek", "region test", 5, "us-en");
        assertEquals("https", endpoint.getScheme());
        assertEquals("www.mojeek.com", endpoint.getHost());
        assertEquals("/search", endpoint.getPath());
        assertTrue(endpoint.getRawQuery().contains("q=region%20test"));
        assertTrue(endpoint.getRawQuery().contains("reg=us"));
    }

    @Test
    public void requestIdentifiersAreBoundedOpaqueValues() {
        assertTrue(WebSearchService.isValidRequestId("01234567-89ab-cdef-0123-456789abcdef"));
        assertFalse(WebSearchService.isValidRequestId("shared"));
        assertFalse(WebSearchService.isValidRequestId("request with spaces"));
    }

    @Test
    public void totalDeadlineDisconnectsBlockedResponseHeadersAndReturnsTimeout() throws Exception {
        AtomicReference<BlockingHttpsURLConnection> opened = new AtomicReference<>();
        WebSearchService service = new WebSearchService(endpoint -> {
            BlockingHttpsURLConnection connection = new BlockingHttpsURLConnection(endpoint, true);
            opened.set(connection);
            return connection;
        }, 50);
        String requestId = "request-header-deadline";
        try {
            service.beginRequest(requestId, () -> {});
            assertTrue(service.startRequest(requestId));

            WebSearchService.SearchAttempt result = service.fetch(
                "duckduckgo",
                "header deadline",
                5,
                "",
                WebSearchService.deadlineAfterMillis(System.nanoTime(), 50),
                requestId
            );

            assertFalse(result.ok);
            assertEquals(WebSearchService.TIMEOUT, result.code);
            assertTrue(opened.get().disconnected);
        } finally {
            service.finishRequest(requestId);
            service.shutdown();
            assertTrue(service.isDeadlineExecutorShutdown());
        }
    }

    @Test
    public void totalDeadlineDisconnectsBlockedResponseBodyAndReturnsTimeout() throws Exception {
        AtomicReference<BlockingHttpsURLConnection> opened = new AtomicReference<>();
        WebSearchService service = new WebSearchService(endpoint -> {
            BlockingHttpsURLConnection connection = new BlockingHttpsURLConnection(endpoint, false);
            opened.set(connection);
            return connection;
        }, 50);
        String requestId = "request-body-deadline1";
        try {
            service.beginRequest(requestId, () -> {});
            assertTrue(service.startRequest(requestId));

            WebSearchService.SearchAttempt result = service.fetch(
                "duckduckgo",
                "body deadline",
                5,
                "",
                WebSearchService.deadlineAfterMillis(System.nanoTime(), 50),
                requestId
            );

            assertFalse(result.ok);
            assertEquals(WebSearchService.TIMEOUT, result.code);
            assertTrue(opened.get().disconnected);
        } finally {
            service.finishRequest(requestId);
            service.shutdown();
            assertTrue(service.isDeadlineExecutorShutdown());
        }
    }

    private static void await(CountDownLatch started, CountDownLatch release) {
        started.countDown();
        try {
            release.await();
        } catch (InterruptedException exception) {
            Thread.currentThread().interrupt();
        }
    }

    private static final class BlockingHttpsURLConnection extends HttpsURLConnection {
        private final boolean blockHeaders;
        private final CountDownLatch disconnectRequested = new CountDownLatch(1);
        private volatile boolean disconnected;

        BlockingHttpsURLConnection(URL endpoint, boolean blockHeaders) {
            super(endpoint);
            this.blockHeaders = blockHeaders;
        }

        @Override
        public int getResponseCode() throws IOException {
            if (blockHeaders) {
                awaitDisconnect();
                throw new IOException("deadline disconnected response headers");
            }
            return 200;
        }

        @Override
        public String getHeaderField(String name) {
            return "Content-Type".equalsIgnoreCase(name) ? "text/html; charset=utf-8" : null;
        }

        @Override
        public InputStream getInputStream() {
            return new InputStream() {
                @Override
                public int read() throws IOException {
                    awaitDisconnect();
                    throw new IOException("deadline disconnected response body");
                }

                @Override
                public int read(byte[] buffer, int offset, int length) throws IOException {
                    return read();
                }
            };
        }

        private void awaitDisconnect() throws IOException {
            try {
                if (!disconnectRequested.await(2, TimeUnit.SECONDS)) {
                    throw new IOException("deadline did not disconnect the search connection");
                }
            } catch (InterruptedException exception) {
                Thread.currentThread().interrupt();
                throw new IOException("interrupted", exception);
            }
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
