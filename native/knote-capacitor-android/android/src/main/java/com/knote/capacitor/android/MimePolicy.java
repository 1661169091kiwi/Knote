package com.knote.capacitor.android;

import java.util.regex.Pattern;

final class MimePolicy {
    static final int MAX_MIME_TYPES = 32;

    private static final Pattern MIME = Pattern.compile("^(?:\\*|[A-Za-z0-9!#$&^_.+-]+)/[A-Za-z0-9!#$&^_.+*-]+$");

    private MimePolicy() {}

    static String validate(String value, boolean allowWildcard) throws KnoteException {
        if (value == null || value.isEmpty() || value.length() > 127 || !MIME.matcher(value).matches()) {
            throw invalid();
        }
        int slash = value.indexOf('/');
        String type = value.substring(0, slash);
        String subtype = value.substring(slash + 1);
        boolean wildcard = type.indexOf('*') >= 0 || subtype.indexOf('*') >= 0;
        if ((!allowWildcard && wildcard) || (type.equals("*") && !subtype.equals("*"))) {
            throw invalid();
        }
        if (wildcard && !subtype.equals("*")) {
            throw invalid();
        }
        return value;
    }

    private static KnoteException invalid() {
        return new KnoteException(ErrorCodes.TYPE_MISMATCH, "Invalid MIME type");
    }
}
