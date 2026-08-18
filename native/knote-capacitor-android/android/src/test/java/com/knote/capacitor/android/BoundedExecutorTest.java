package com.knote.capacitor.android;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

import java.util.concurrent.CountDownLatch;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.Test;

public class BoundedExecutorTest {
    @Test
    public void rejectsWorkWhenItsExplicitQueueCapacityIsFull() throws Exception {
        ThreadPoolExecutor executor = BoundedExecutor.create(1, 1);
        CountDownLatch started = new CountDownLatch(1);
        CountDownLatch release = new CountDownLatch(1);
        try {
            executor.execute(() -> await(started, release));
            assertTrue(started.await(2, TimeUnit.SECONDS));
            executor.execute(() -> {});

            assertEquals(0, executor.getQueue().remainingCapacity());
            assertThrows(RejectedExecutionException.class, () -> executor.execute(() -> {}));
        } finally {
            release.countDown();
            executor.shutdownNow();
            assertTrue(executor.awaitTermination(2, TimeUnit.SECONDS));
        }
    }

    @Test
    public void removesOnlyTheExactQueuedTaskAndStillRunsItsPeer() throws Exception {
        ThreadPoolExecutor executor = BoundedExecutor.create(1, 2);
        CountDownLatch started = new CountDownLatch(1);
        CountDownLatch release = new CountDownLatch(1);
        CountDownLatch peerFinished = new CountDownLatch(1);
        AtomicInteger removedRuns = new AtomicInteger();
        Runnable removed = removedRuns::incrementAndGet;
        try {
            executor.execute(() -> await(started, release));
            assertTrue(started.await(2, TimeUnit.SECONDS));
            executor.execute(removed);
            executor.execute(peerFinished::countDown);

            assertTrue(executor.remove(removed));
            release.countDown();
            assertTrue(peerFinished.await(2, TimeUnit.SECONDS));
            assertEquals(0, removedRuns.get());
        } finally {
            release.countDown();
            executor.shutdownNow();
            assertTrue(executor.awaitTermination(2, TimeUnit.SECONDS));
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
}
