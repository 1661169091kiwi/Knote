package com.knote.capacitor.android;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.fail;

import org.junit.Test;

public class Base64PolicyTest {
    @Test
    public void acceptsPaddedAndUnpaddedBase64() throws Exception {
        assertEquals(0, Base64Policy.validateAndGetDecodedLength(""));
        assertEquals(1, Base64Policy.validateAndGetDecodedLength("Zg=="));
        assertEquals(1, Base64Policy.validateAndGetDecodedLength("Zg"));
        assertEquals(2, Base64Policy.validateAndGetDecodedLength("Zm8="));
        assertEquals(3, Base64Policy.validateAndGetDecodedLength("Zm9v"));
    }

    @Test
    public void rejectsMalformedBase64BeforeDecoding() {
        assertInvalid("A");
        assertInvalid("Z===");
        assertInvalid("Zg=");
        assertInvalid("Zg==A");
        assertInvalid("Zg==\n");
        assertInvalid("-_8=");
        assertInvalid("Zh==");
        assertInvalid("Zm9");
    }

    private static void assertInvalid(String value) {
        try {
            Base64Policy.validateAndGetDecodedLength(value);
            fail("Expected invalid base64");
        } catch (KnoteException exception) {
            assertEquals(ErrorCodes.TYPE_MISMATCH, exception.getCode());
        }
    }
}
