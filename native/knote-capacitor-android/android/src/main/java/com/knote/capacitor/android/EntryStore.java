package com.knote.capacitor.android;

import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/** In-memory capabilities for tree children. Provider identifiers never cross the JS boundary. */
final class EntryStore {
    private static final int ENTRY_ID_BYTES = 32;
    private static final int MAX_ENTRIES = 20_000;
    private static final char[] BASE64_URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_".toCharArray();

    private final SecureRandom random = new SecureRandom();
    private final Map<String, EntryRecord> records = new HashMap<>();
    private final Map<String, String> idsByPath = new HashMap<>();

    synchronized String bind(
        String grantId,
        String uri,
        String path,
        boolean directory,
        String mimeType,
        long size,
        long lastModified
    ) throws KnoteException {
        String pathKey = pathKey(grantId, path);
        String pathId = idsByPath.get(pathKey);
        EntryRecord existing = pathId == null ? null : records.get(pathId);
        if (
            existing != null &&
            existing.uri.equals(uri) &&
            existing.matches(directory, mimeType, size, lastModified)
        ) {
            return existing.entryId;
        }

        removeRecord(pathId);
        if (records.size() >= MAX_ENTRIES) {
            throw new KnoteException(ErrorCodes.UNSUPPORTED_OPERATION, "Too many live document capabilities");
        }
        String entryId = newEntryId();
        EntryRecord record = new EntryRecord(entryId, grantId, uri, path, directory, mimeType, size, lastModified);
        records.put(entryId, record);
        idsByPath.put(pathKey, entryId);
        return entryId;
    }

    synchronized void require(
        String grantId,
        String entryId,
        String uri,
        String path,
        boolean directory,
        String mimeType,
        long size,
        long lastModified
    ) throws KnoteException {
        if (!isEntryId(entryId)) {
            throw changed();
        }
        EntryRecord record = records.get(entryId);
        if (
            record == null ||
            !record.grantId.equals(grantId) ||
            !record.uri.equals(uri) ||
            !record.path.equals(path) ||
            !entryId.equals(idsByPath.get(pathKey(grantId, path))) ||
            !record.matches(directory, mimeType, size, lastModified)
        ) {
            throw changed();
        }
    }

    synchronized void update(
        String grantId,
        String entryId,
        String uri,
        String path,
        boolean directory,
        String mimeType,
        long size,
        long lastModified
    ) throws KnoteException {
        if (!isEntryId(entryId)) {
            throw changed();
        }
        EntryRecord previous = records.get(entryId);
        if (
            previous == null ||
            !previous.grantId.equals(grantId) ||
            !entryId.equals(idsByPath.get(pathKey(previous.grantId, previous.path)))
        ) {
            throw changed();
        }

        List<EntryRecord> moving = new ArrayList<>();
        moving.add(previous);
        if (previous.directory && !previous.path.equals(path)) {
            String prefix = previous.path + "/";
            for (EntryRecord record : records.values()) {
                if (record != previous && record.grantId.equals(grantId) && record.path.startsWith(prefix)) {
                    moving.add(record);
                }
            }
        }
        Set<String> movingIds = new HashSet<>();
        for (EntryRecord record : moving) {
            movingIds.add(record.entryId);
        }

        for (EntryRecord record : moving) {
            String nextPath = record == previous
                ? path
                : path + record.path.substring(previous.path.length());
            String displaced = idsByPath.get(pathKey(grantId, nextPath));
            if (displaced != null && !movingIds.contains(displaced)) {
                removeRecord(displaced);
            }
        }
        for (EntryRecord record : moving) {
            removeIndexes(record);
        }
        for (EntryRecord record : moving) {
            String nextPath = record == previous
                ? path
                : path + record.path.substring(previous.path.length());
            EntryRecord updated = record == previous
                ? new EntryRecord(entryId, grantId, uri, nextPath, directory, mimeType, size, lastModified)
                : record.withPath(nextPath);
            records.put(updated.entryId, updated);
            idsByPath.put(pathKey(updated.grantId, updated.path), updated.entryId);
        }
    }

    synchronized void refreshBinding(
        String grantId,
        String uri,
        String path,
        boolean directory,
        String mimeType,
        long size,
        long lastModified
    ) throws KnoteException {
        String entryId = idsByPath.get(pathKey(grantId, path));
        EntryRecord record = entryId == null ? null : records.get(entryId);
        if (record != null && record.uri.equals(uri)) {
            update(grantId, entryId, uri, path, directory, mimeType, size, lastModified);
        }
    }

    synchronized void forget(String entryId) {
        removeRecord(entryId);
    }

    synchronized void forgetPath(String grantId, String path, boolean recursive) throws KnoteException {
        List<String> removed = new ArrayList<>();
        String prefix = path + "/";
        for (EntryRecord record : records.values()) {
            if (
                record.grantId.equals(grantId) &&
                (record.path.equals(path) || (recursive && record.path.startsWith(prefix)))
            ) {
                removed.add(record.entryId);
            }
        }
        for (String entryId : removed) {
            removeRecord(entryId);
        }
    }

    synchronized void forgetGrant(String grantId) {
        List<String> removed = new ArrayList<>();
        for (EntryRecord record : records.values()) {
            if (record.grantId.equals(grantId)) {
                removed.add(record.entryId);
            }
        }
        for (String entryId : removed) {
            removeRecord(entryId);
        }
    }

    synchronized void clear() {
        records.clear();
        idsByPath.clear();
    }

    private String newEntryId() {
        for (int attempt = 0; attempt < 128; attempt++) {
            byte[] bytes = new byte[ENTRY_ID_BYTES];
            random.nextBytes(bytes);
            String candidate = encodeBase64Url(bytes);
            if (!records.containsKey(candidate)) {
                return candidate;
            }
        }
        throw new IllegalStateException("Could not allocate an entry capability");
    }

    private void removeRecord(String entryId) {
        if (entryId == null) {
            return;
        }
        EntryRecord record = records.remove(entryId);
        if (record != null) {
            removeIndexes(record);
        }
    }

    private void removeIndexes(EntryRecord record) {
        try {
            idsByPath.remove(pathKey(record.grantId, record.path), record.entryId);
        } catch (KnoteException ignored) {}
    }

    private static String pathKey(String grantId, String path) throws KnoteException {
        if (grantId == null || path == null) {
            throw new KnoteException(ErrorCodes.IO_ERROR, "Invalid entry capability binding");
        }
        return grantId + ':' + path;
    }

    private static boolean isEntryId(String value) {
        if (value == null || value.length() != 43) {
            return false;
        }
        for (int index = 0; index < value.length(); index++) {
            char character = value.charAt(index);
            if (!((character >= 'A' && character <= 'Z') ||
                (character >= 'a' && character <= 'z') ||
                (character >= '0' && character <= '9') ||
                character == '-' || character == '_')) {
                return false;
            }
        }
        return true;
    }

    private static String encodeBase64Url(byte[] value) {
        StringBuilder output = new StringBuilder((value.length * 4 + 2) / 3);
        int index = 0;
        while (index + 2 < value.length) {
            int bits = ((value[index] & 0xff) << 16) |
                ((value[index + 1] & 0xff) << 8) |
                (value[index + 2] & 0xff);
            output.append(BASE64_URL[(bits >>> 18) & 0x3f]);
            output.append(BASE64_URL[(bits >>> 12) & 0x3f]);
            output.append(BASE64_URL[(bits >>> 6) & 0x3f]);
            output.append(BASE64_URL[bits & 0x3f]);
            index += 3;
        }
        int remaining = value.length - index;
        if (remaining == 1) {
            int bits = (value[index] & 0xff) << 16;
            output.append(BASE64_URL[(bits >>> 18) & 0x3f]);
            output.append(BASE64_URL[(bits >>> 12) & 0x3f]);
        } else if (remaining == 2) {
            int bits = ((value[index] & 0xff) << 16) | ((value[index + 1] & 0xff) << 8);
            output.append(BASE64_URL[(bits >>> 18) & 0x3f]);
            output.append(BASE64_URL[(bits >>> 12) & 0x3f]);
            output.append(BASE64_URL[(bits >>> 6) & 0x3f]);
        }
        return output.toString();
    }

    private static KnoteException changed() {
        return new KnoteException(ErrorCodes.ENTRY_CHANGED, "Document entry changed; refresh the granted tree");
    }

    private static final class EntryRecord {
        final String entryId;
        final String grantId;
        final String uri;
        final String path;
        final boolean directory;
        final String mimeType;
        final long size;
        final long lastModified;

        EntryRecord(
            String entryId,
            String grantId,
            String uri,
            String path,
            boolean directory,
            String mimeType,
            long size,
            long lastModified
        ) {
            this.entryId = entryId;
            this.grantId = grantId;
            this.uri = uri;
            this.path = path;
            this.directory = directory;
            this.mimeType = mimeType;
            this.size = size;
            this.lastModified = lastModified;
        }

        EntryRecord withPath(String nextPath) {
            return new EntryRecord(entryId, grantId, uri, nextPath, directory, mimeType, size, lastModified);
        }

        boolean matches(boolean expectedDirectory, String expectedMimeType, long expectedSize, long expectedLastModified) {
            return directory == expectedDirectory &&
                same(mimeType, expectedMimeType) &&
                size == expectedSize &&
                lastModified == expectedLastModified;
        }

        private static boolean same(String left, String right) {
            return left == null ? right == null : right != null && left.equalsIgnoreCase(right);
        }
    }
}
