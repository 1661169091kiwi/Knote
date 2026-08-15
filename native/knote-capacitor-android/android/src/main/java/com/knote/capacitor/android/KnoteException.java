package com.knote.capacitor.android;

final class KnoteException extends Exception {
    private final String code;

    KnoteException(String code, String message) {
        super(message);
        this.code = code;
    }

    String getCode() {
        return code;
    }
}
