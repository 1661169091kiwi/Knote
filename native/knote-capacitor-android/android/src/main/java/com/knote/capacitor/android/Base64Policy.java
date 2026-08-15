package com.knote.capacitor.android;

final class Base64Policy {
    static final int MAX_BYTES = 32 * 1024 * 1024;
    static final int MAX_ENCODED_CHARS = ((MAX_BYTES + 2) / 3) * 4;

    private Base64Policy() {}

    static int validateAndGetDecodedLength(String value) throws KnoteException {
        if (value == null || value.length() > MAX_ENCODED_CHARS) {
            throw invalid();
        }

        int padding = 0;
        boolean sawPadding = false;
        for (int index = 0; index < value.length(); index++) {
            char character = value.charAt(index);
            if (character == '=') {
                sawPadding = true;
                padding++;
                if (padding > 2) {
                    throw invalid();
                }
            } else {
                if (sawPadding || !isBase64Character(character)) {
                    throw invalid();
                }
            }
        }

        int nonPadding = value.length() - padding;
        int remainder = nonPadding % 4;
        if (remainder == 1) {
            throw invalid();
        }
        if (padding > 0) {
            int expectedPadding = remainder == 2 ? 2 : remainder == 3 ? 1 : 0;
            if (value.length() % 4 != 0 || padding != expectedPadding) {
                throw invalid();
            }
        }
        if (
            (remainder == 2 && (base64Value(value.charAt(nonPadding - 1)) & 0x0f) != 0) ||
            (remainder == 3 && (base64Value(value.charAt(nonPadding - 1)) & 0x03) != 0)
        ) {
            throw invalid();
        }

        long decodedLength = ((long) nonPadding / 4L) * 3L;
        if (remainder == 2) {
            decodedLength++;
        } else if (remainder == 3) {
            decodedLength += 2;
        }
        if (decodedLength > MAX_BYTES) {
            throw invalid();
        }
        return (int) decodedLength;
    }

    private static boolean isBase64Character(char value) {
        return (value >= 'A' && value <= 'Z') ||
            (value >= 'a' && value <= 'z') ||
            (value >= '0' && value <= '9') ||
            value == '+' ||
            value == '/';
    }

    private static int base64Value(char value) {
        if (value >= 'A' && value <= 'Z') {
            return value - 'A';
        }
        if (value >= 'a' && value <= 'z') {
            return value - 'a' + 26;
        }
        if (value >= '0' && value <= '9') {
            return value - '0' + 52;
        }
        return value == '+' ? 62 : 63;
    }

    private static KnoteException invalid() {
        return new KnoteException(ErrorCodes.TYPE_MISMATCH, "Invalid or oversized base64 data");
    }
}
