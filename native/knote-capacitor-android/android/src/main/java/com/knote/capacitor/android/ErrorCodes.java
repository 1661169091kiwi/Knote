package com.knote.capacitor.android;

final class ErrorCodes {
    static final String PICKER_CANCELLED = "PICKER_CANCELLED";
    static final String BAD_GRANT = "BAD_GRANT";
    static final String GRANT_REVOKED = "GRANT_REVOKED";
    static final String READ_ONLY = "READ_ONLY";
    static final String BAD_PATH = "BAD_PATH";
    static final String NOT_FOUND = "NOT_FOUND";
    static final String TYPE_MISMATCH = "TYPE_MISMATCH";
    static final String TARGET_EXISTS = "TARGET_EXISTS";
    static final String ENTRY_CHANGED = "ENTRY_CHANGED";
    static final String UNSUPPORTED_OPERATION = "UNSUPPORTED_OPERATION";
    static final String WRITE_COMMIT_UNCERTAIN = "WRITE_COMMIT_UNCERTAIN";
    static final String MUTATION_COMMIT_UNCERTAIN = "MUTATION_COMMIT_UNCERTAIN";
    static final String PROVIDER_CANCELLED = "PROVIDER_CANCELLED";
    static final String PROVIDER_TIMEOUT = "PROVIDER_TIMEOUT";
    static final String PROVIDER_NETWORK_ERROR = "PROVIDER_NETWORK_ERROR";
    static final String PROVIDER_REQUEST_TOO_LARGE = "PROVIDER_REQUEST_TOO_LARGE";
    static final String PROVIDER_RESPONSE_TOO_LARGE = "PROVIDER_RESPONSE_TOO_LARGE";
    static final String PROVIDER_INVALID_RESPONSE = "PROVIDER_INVALID_RESPONSE";
    static final String PROVIDER_INVALID_INPUT = "PROVIDER_INVALID_INPUT";
    static final String PROVIDER_QUEUE_FULL = "PROVIDER_QUEUE_FULL";
    static final String IO_ERROR = "IO_ERROR";

    private ErrorCodes() {}
}
