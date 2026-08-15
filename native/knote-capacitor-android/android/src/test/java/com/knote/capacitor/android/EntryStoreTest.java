package com.knote.capacitor.android;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotEquals;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import org.junit.Test;

public class EntryStoreTest {
    private static final String GRANT_A = "grant-a";
    private static final String GRANT_B = "grant-b";

    @Test
    public void reusesOnlyAnExactAuthoritativeBinding() throws Exception {
        EntryStore store = new EntryStore();
        String first = store.bind(GRANT_A, "content://provider/tree/root/document/a", "a.md", false, "text/markdown", 4, 10);
        String same = store.bind(GRANT_A, "content://provider/tree/root/document/a", "a.md", false, "TEXT/MARKDOWN", 4, 10);

        assertEquals(first, same);
        assertEquals(43, first.length());
        assertTrue(first.matches("[A-Za-z0-9_-]{43}"));
        store.require(GRANT_A, first, "content://provider/tree/root/document/a", "a.md", false, "text/markdown", 4, 10);
    }

    @Test
    public void rotatesOnMetadataTransitionsAndPathReplacement() throws Exception {
        EntryStore store = new EntryStore();
        String unknown = store.bind(GRANT_A, "content://provider/document/a", "a.md", false, "text/markdown", -1, -1);
        String known = store.bind(GRANT_A, "content://provider/document/a", "a.md", false, "text/markdown", 4, 10);
        assertNotEquals(unknown, known);
        assertChanged(() -> store.require(GRANT_A, unknown, "content://provider/document/a", "a.md", false, "text/markdown", -1, -1));

        String replacement = store.bind(GRANT_A, "content://provider/document/replacement", "a.md", false, "text/markdown", 4, 10);
        assertNotEquals(known, replacement);
        assertChanged(() -> store.require(GRANT_A, known, "content://provider/document/a", "a.md", false, "text/markdown", 4, 10));
        store.require(GRANT_A, replacement, "content://provider/document/replacement", "a.md", false, "text/markdown", 4, 10);
    }

    @Test
    public void directoryMovesPreserveDescendantCapabilitiesAtNewPaths() throws Exception {
        EntryStore store = new EntryStore();
        String folder = store.bind(GRANT_A, "content://provider/document/folder", "folder", true, "vnd.android.document/directory", -1, 10);
        String child = store.bind(GRANT_A, "content://provider/document/child", "folder/child.md", false, "text/markdown", 3, 11);
        String nested = store.bind(GRANT_A, "content://provider/document/nested", "folder/sub", true, "vnd.android.document/directory", -1, 12);

        store.update(GRANT_A, folder, "content://provider/document/folder", "archive", true, "vnd.android.document/directory", -1, 13);

        store.require(GRANT_A, folder, "content://provider/document/folder", "archive", true, "vnd.android.document/directory", -1, 13);
        store.require(GRANT_A, child, "content://provider/document/child", "archive/child.md", false, "text/markdown", 3, 11);
        store.require(GRANT_A, nested, "content://provider/document/nested", "archive/sub", true, "vnd.android.document/directory", -1, 12);
        assertChanged(() -> store.require(GRANT_A, child, "content://provider/document/child", "folder/child.md", false, "text/markdown", 3, 11));
    }

    @Test
    public void updateRevokesCapabilitiesDisplacedAtTheDestination() throws Exception {
        EntryStore store = new EntryStore();
        String source = store.bind(GRANT_A, "content://provider/document/source", "source.md", false, "text/markdown", 1, 1);
        String destination = store.bind(GRANT_A, "content://provider/document/destination", "destination.md", false, "text/markdown", 2, 2);

        store.update(GRANT_A, source, "content://provider/document/source", "destination.md", false, "text/markdown", 1, 3);

        store.require(GRANT_A, source, "content://provider/document/source", "destination.md", false, "text/markdown", 1, 3);
        assertChanged(() -> store.require(GRANT_A, destination, "content://provider/document/destination", "destination.md", false, "text/markdown", 2, 2));
    }

    @Test
    public void supportsOneProviderDocumentAtMultipleTreePaths() throws Exception {
        EntryStore store = new EntryStore();
        String first = store.bind(GRANT_A, "content://provider/document/shared", "one/shared.md", false, "text/markdown", 2, 3);
        String second = store.bind(GRANT_A, "content://provider/document/shared", "two/shared.md", false, "text/markdown", 2, 3);

        assertNotEquals(first, second);
        store.require(GRANT_A, first, "content://provider/document/shared", "one/shared.md", false, "text/markdown", 2, 3);
        store.require(GRANT_A, second, "content://provider/document/shared", "two/shared.md", false, "text/markdown", 2, 3);
    }

    @Test
    public void recursiveForgetIsScopedToOneGrantAndSubtree() throws Exception {
        EntryStore store = new EntryStore();
        String root = store.bind(GRANT_A, "content://provider/document/folder", "folder", true, "vnd.android.document/directory", -1, 1);
        String child = store.bind(GRANT_A, "content://provider/document/child", "folder/child.md", false, "text/markdown", 1, 2);
        String sibling = store.bind(GRANT_A, "content://provider/document/sibling", "sibling.md", false, "text/markdown", 1, 2);
        String otherGrant = store.bind(GRANT_B, "content://provider/document/child", "folder/child.md", false, "text/markdown", 1, 2);

        store.forgetPath(GRANT_A, "folder", true);

        assertChanged(() -> store.require(GRANT_A, root, "content://provider/document/folder", "folder", true, "vnd.android.document/directory", -1, 1));
        assertChanged(() -> store.require(GRANT_A, child, "content://provider/document/child", "folder/child.md", false, "text/markdown", 1, 2));
        store.require(GRANT_A, sibling, "content://provider/document/sibling", "sibling.md", false, "text/markdown", 1, 2);
        store.require(GRANT_B, otherGrant, "content://provider/document/child", "folder/child.md", false, "text/markdown", 1, 2);
    }

    @Test
    public void rejectsMalformedAndMismatchedCapabilities() throws Exception {
        EntryStore store = new EntryStore();
        String entry = store.bind(GRANT_A, "content://provider/document/a", "a.md", false, "text/markdown", 1, 2);

        assertChanged(() -> store.require(GRANT_A, "not-a-capability", "content://provider/document/a", "a.md", false, "text/markdown", 1, 2));
        assertChanged(() -> store.require(GRANT_B, entry, "content://provider/document/a", "a.md", false, "text/markdown", 1, 2));
        assertChanged(() -> store.require(GRANT_A, entry, "content://provider/document/a", "b.md", false, "text/markdown", 1, 2));
        assertChanged(() -> store.require(GRANT_A, entry, "content://provider/document/a", "a.md", true, "text/markdown", 1, 2));
        assertChanged(() -> store.require(GRANT_A, entry, "content://provider/document/a", "a.md", false, "text/plain", 1, 2));
        assertChanged(() -> store.require(GRANT_A, entry, "content://provider/document/a", "a.md", false, "text/markdown", 2, 2));
        assertChanged(() -> store.require(GRANT_A, entry, "content://provider/document/a", "a.md", false, "text/markdown", 1, 3));
    }

    private static void assertChanged(CheckedRunnable operation) {
        try {
            operation.run();
            fail("Expected ENTRY_CHANGED");
        } catch (KnoteException exception) {
            assertEquals(ErrorCodes.ENTRY_CHANGED, exception.getCode());
        }
    }

    private interface CheckedRunnable {
        void run() throws KnoteException;
    }
}
