package com.knote.capacitor.android;

import java.text.Normalizer;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.regex.Pattern;

final class PathPolicy {
    static final int MAX_PATH_CODE_POINTS = 1024;
    static final int MAX_SEGMENT_CODE_POINTS = 255;
    static final int MAX_SEGMENTS = 64;
    private static final int MAX_RAW_PATH_CHARS = MAX_PATH_CODE_POINTS * 2;
    private static final int MAX_RAW_NAME_CHARS = MAX_SEGMENT_CODE_POINTS * 2;

    private static final Pattern SCHEME = Pattern.compile("^[A-Za-z][A-Za-z0-9+.-]*:.*$");

    private PathPolicy() {}

    static NormalizedPath normalize(String input, boolean allowEmpty) throws KnoteException {
        if (input == null || input.length() > MAX_RAW_PATH_CHARS) {
            throw badPath();
        }

        validateUnicode(input);
        String normalized = Normalizer.normalize(input, Normalizer.Form.NFC);
        if (normalized.isEmpty()) {
            if (allowEmpty) {
                return new NormalizedPath("", Collections.emptyList());
            }
            throw badPath();
        }
        if (codePointLength(normalized) > MAX_PATH_CODE_POINTS) {
            throw badPath();
        }

        String[] rawSegments = normalized.split("/", -1);
        if (rawSegments.length > MAX_SEGMENTS) {
            throw badPath();
        }

        List<String> segments = new ArrayList<>(rawSegments.length);
        for (String rawSegment : rawSegments) {
            segments.add(normalizeName(rawSegment));
        }
        String value = join(segments);
        if (codePointLength(value) > MAX_PATH_CODE_POINTS) {
            throw badPath();
        }
        return new NormalizedPath(value, Collections.unmodifiableList(segments));
    }

    static String normalizeName(String input) throws KnoteException {
        if (input == null || input.length() > MAX_RAW_NAME_CHARS) {
            throw badPath();
        }
        validateUnicode(input);
        String normalized = Normalizer.normalize(input, Normalizer.Form.NFC);
        if (normalized.isEmpty() || codePointLength(normalized) > MAX_SEGMENT_CODE_POINTS) {
            throw badPath();
        }
        inspectSegment(normalized);
        return normalized;
    }

    static String requireCanonicalName(String input) throws KnoteException {
        String normalized = normalizeName(input);
        if (!normalized.equals(input)) {
            throw badPath();
        }
        return normalized;
    }

    static void requireCanonicalInput(String input, NormalizedPath normalized) throws KnoteException {
        if (input == null || !input.equals(normalized.value)) {
            throw badPath();
        }
    }

    static boolean isForbiddenCodePoint(int codePoint) {
        int type = Character.getType(codePoint);
        if (type == Character.CONTROL || type == Character.LINE_SEPARATOR || type == Character.PARAGRAPH_SEPARATOR) {
            return true;
        }
        return codePoint == 0x061c ||
            codePoint == 0x200e ||
            codePoint == 0x200f ||
            (codePoint >= 0x202a && codePoint <= 0x202e) ||
            (codePoint >= 0x2066 && codePoint <= 0x206f) ||
            codePoint == 0xfeff;
    }

    static String safeDisplayName(String value, String fallback) {
        if (value == null || value.isEmpty()) {
            return fallback;
        }
        try {
            validateUnicode(value);
        } catch (KnoteException exception) {
            return fallback;
        }
        try {
            value = Normalizer.normalize(value, Normalizer.Form.NFC);
        } catch (OutOfMemoryError | RuntimeException error) {
            return fallback;
        }
        StringBuilder output = new StringBuilder();
        int count = 0;
        for (int offset = 0; offset < value.length() && count < MAX_SEGMENT_CODE_POINTS;) {
            int codePoint = value.codePointAt(offset);
            offset += Character.charCount(codePoint);
            count++;
            if (isForbiddenCodePoint(codePoint)) {
                output.append(' ');
            } else if (codePoint == '/' || codePoint == '\\') {
                output.append('_');
            } else {
                output.appendCodePoint(codePoint);
            }
        }
        String result = output.toString().trim();
        return result.isEmpty() ? fallback : result;
    }

    private static void inspectSegment(String segment) throws KnoteException {
        if (segment.isEmpty() || segment.equals(".") || segment.equals("..")) {
            throw badPath();
        }
        if (
            segment.indexOf('/') >= 0 ||
            segment.indexOf('\\') >= 0 ||
            SCHEME.matcher(segment).matches()
        ) {
            throw badPath();
        }
        for (int offset = 0; offset < segment.length();) {
            int codePoint = segment.codePointAt(offset);
            if (isForbiddenCodePoint(codePoint) || codePoint == 0xfffd) {
                throw badPath();
            }
            offset += Character.charCount(codePoint);
        }
    }

    private static int codePointLength(String value) {
        return value.codePointCount(0, value.length());
    }

    private static void validateUnicode(String value) throws KnoteException {
        for (int index = 0; index < value.length(); index++) {
            char character = value.charAt(index);
            if (Character.isHighSurrogate(character)) {
                if (index + 1 >= value.length() || !Character.isLowSurrogate(value.charAt(index + 1))) {
                    throw badPath();
                }
                index++;
            } else if (Character.isLowSurrogate(character)) {
                throw badPath();
            }
        }
    }

    static String join(List<String> segments) {
        StringBuilder output = new StringBuilder();
        for (String segment : segments) {
            if (output.length() > 0) {
                output.append('/');
            }
            output.append(segment);
        }
        return output.toString();
    }

    private static KnoteException badPath() {
        return new KnoteException(ErrorCodes.BAD_PATH, "Invalid relative path");
    }

    static final class NormalizedPath {
        final String value;
        final List<String> segments;

        NormalizedPath(String value, List<String> segments) {
            this.value = value;
            this.segments = segments;
        }
    }

}
