package com.knote.capacitor.android;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.fail;

import org.junit.Test;

public class MimePolicyTest {
    @Test
    public void acceptsConcreteAndPickerWildcardMimeTypes() throws Exception {
        assertEquals("text/plain", MimePolicy.validate("text/plain", false));
        assertEquals("image/*", MimePolicy.validate("image/*", true));
        assertEquals("*/*", MimePolicy.validate("*/*", true));
    }

    @Test
    public void rejectsMalformedOrCreationWildcards() {
        assertInvalid("text", true);
        assertInvalid("*/plain", true);
        assertInvalid("image/p*ng", true);
        assertInvalid("image/*", false);
        assertInvalid("text/plain; charset=utf-8", false);
    }

    private static void assertInvalid(String value, boolean wildcard) {
        try {
            MimePolicy.validate(value, wildcard);
            fail("Expected invalid MIME type");
        } catch (KnoteException exception) {
            assertEquals(ErrorCodes.TYPE_MISMATCH, exception.getCode());
        }
    }
}
