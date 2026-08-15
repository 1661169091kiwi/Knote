package com.knote.capacitor.android;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import java.util.Arrays;
import org.junit.Test;

public class PathPolicyTest {
    @Test
    public void acceptsNormalizedRelativePaths() throws Exception {
        PathPolicy.NormalizedPath path = PathPolicy.normalize("notes/2026/file.txt", false);
        assertEquals("notes/2026/file.txt", path.value);
        assertEquals(Arrays.asList("notes", "2026", "file.txt"), path.segments);
        assertEquals("", PathPolicy.normalize("", true).value);
    }

    @Test
    public void normalizesUnicodeToNfc() throws Exception {
        PathPolicy.NormalizedPath path = PathPolicy.normalize("caf\u0065\u0301.txt", false);
        assertEquals("caf\u00e9.txt", path.value);
        try {
            PathPolicy.requireCanonicalInput("caf\u0065\u0301.txt", path);
            fail("Expected non-canonical input to be rejected");
        } catch (KnoteException exception) {
            assertEquals(ErrorCodes.BAD_PATH, exception.getCode());
        }
    }

    @Test
    public void rejectsTraversalAndAmbiguousSegments() {
        assertBadPath(".");
        assertBadPath("..");
        assertBadPath("a//b");
        assertBadPath("/a");
        assertBadPath("a/");
        assertBadPath("a\\b");
        assertBadPath("https:payload");
    }

    @Test
    public void treatsPercentAsARegularProviderNameCharacter() throws Exception {
        assertEquals("100%.md", PathPolicy.normalize("100%.md", false).value);
        assertEquals("%2e%2e", PathPolicy.normalize("%2e%2e", false).value);
        assertEquals("safe/a%2fb", PathPolicy.normalize("safe/a%2fb", false).value);
    }

    @Test
    public void rejectsControlsAndBidiControls() {
        assertBadPath("a\u0000b");
        assertBadPath("a\u202eb");
        assertBadPath("a\ud800b");
    }

    @Test
    public void enforcesLengthBudgets() {
        char[] segment = new char[PathPolicy.MAX_SEGMENT_CODE_POINTS + 1];
        Arrays.fill(segment, 'a');
        assertBadPath(new String(segment));

        StringBuilder manySegments = new StringBuilder();
        for (int index = 0; index <= PathPolicy.MAX_SEGMENTS; index++) {
            if (index > 0) {
                manySegments.append('/');
            }
            manySegments.append('a');
        }
        assertBadPath(manySegments.toString());

        char[] raw = new char[PathPolicy.MAX_PATH_CODE_POINTS * 2 + 1];
        Arrays.fill(raw, 'a');
        assertBadPath(new String(raw));
    }

    @Test
    public void sanitizesOpaqueGrantDisplayNames() {
        String result = PathPolicy.safeDisplayName("a/b\\c\u202e", "Document");
        assertEquals("a_b_c", result);
        assertTrue(PathPolicy.safeDisplayName("\u0000", "Document").equals("Document"));
    }

    private static void assertBadPath(String value) {
        try {
            PathPolicy.normalize(value, false);
            fail("Expected BAD_PATH for: " + value);
        } catch (KnoteException exception) {
            assertEquals(ErrorCodes.BAD_PATH, exception.getCode());
        }
    }
}
