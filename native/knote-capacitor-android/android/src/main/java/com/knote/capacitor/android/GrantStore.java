package com.knote.capacitor.android;

import android.content.ContentResolver;
import android.content.Context;
import android.content.SharedPreferences;
import android.content.UriPermission;
import android.database.Cursor;
import android.net.Uri;
import android.os.Bundle;
import android.provider.DocumentsContract;
import android.util.Base64;
import androidx.documentfile.provider.DocumentFile;
import com.getcapacitor.JSObject;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import org.json.JSONException;
import org.json.JSONObject;

final class GrantStore {
    private static final String PREFERENCES_NAME = "knote_android_grants_v1";
    private static final String RECORD_PREFIX = "grant:";
    private static final int GRANT_ID_BYTES = 32;
    private static final int MAX_URI_LENGTH = 16_384;

    private final Context context;
    private final ContentResolver resolver;
    private final SharedPreferences preferences;
    private final SecureRandom secureRandom = new SecureRandom();

    GrantStore(Context context) {
        if (context == null) {
            throw new IllegalArgumentException("Context is required");
        }
        Context applicationContext = context.getApplicationContext();
        this.context = applicationContext == null ? context : applicationContext;
        resolver = this.context.getContentResolver();
        if (resolver == null) {
            throw new IllegalArgumentException("Content resolver is required");
        }
        preferences = this.context.getSharedPreferences(PREFERENCES_NAME, Context.MODE_PRIVATE);
    }

    synchronized GrantAccess savePickedGrant(Uri uri, String kind, String displayName, int requiredFlags) throws KnoteException {
        if (kind == null || (!kind.equals("tree") && !kind.equals("document"))) {
            throw new KnoteException(ErrorCodes.IO_ERROR, "Invalid picker grant kind");
        }
        if (displayName == null) {
            throw new KnoteException(ErrorCodes.IO_ERROR, "Invalid picker display name fallback");
        }
        if ((requiredFlags & ~(android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION | android.content.Intent.FLAG_GRANT_WRITE_URI_PERMISSION)) != 0) {
            throw new KnoteException(ErrorCodes.IO_ERROR, "Invalid persisted grant flags");
        }
        if ((requiredFlags & android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION) == 0) {
            throw new KnoteException(ErrorCodes.IO_ERROR, "Persisted grant must be readable");
        }
        if (uri == null) {
            throw new KnoteException(ErrorCodes.IO_ERROR, "Picker returned no document URI");
        }
        String uriText;
        try {
            uriText = uri.toString();
        } catch (OutOfMemoryError error) {
            throw new KnoteException(ErrorCodes.IO_ERROR, "Picker URI exceeded memory limits");
        } catch (RuntimeException exception) {
            throw new KnoteException(ErrorCodes.IO_ERROR, "Picker returned an invalid document URI");
        }
        if (uriText.length() > MAX_URI_LENGTH) {
            throw new KnoteException(ErrorCodes.IO_ERROR, "Picker returned an oversized document URI");
        }
        if (
            !"content".equals(uri.getScheme()) ||
            uri.getAuthority() == null ||
            uri.getAuthority().isEmpty() ||
            uri.getAuthority().length() > 255
        ) {
            throw new KnoteException(ErrorCodes.IO_ERROR, "Picker returned an invalid document URI");
        }
        validatePickedUri(uri, kind);
        PermissionState permission = findPermission(uri);
        boolean requireRead = (requiredFlags & android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION) != 0;
        boolean requireWrite = (requiredFlags & android.content.Intent.FLAG_GRANT_WRITE_URI_PERMISSION) != 0;
        if (
            permission == null ||
            (requireRead && !permission.readable) ||
            (requireWrite && !permission.writable)
        ) {
            throw new KnoteException(ErrorCodes.IO_ERROR, "Persisted permission was not acquired");
        }

        List<GrantRecord> records = readRecords();
        GrantRecord existing = null;
        for (GrantRecord record : records) {
            if (record.uri.equals(uriText) && (existing == null || record.grantId.compareTo(existing.grantId) < 0)) {
                existing = record;
            }
        }
        if (existing == null && records.size() >= 1024) {
            throw new KnoteException(ErrorCodes.IO_ERROR, "Grant record limit reached");
        }
        RootMetadata pickedMetadata = queryPickedMetadata(uri, kind);
        if (existing != null) {
            try {
                reconcile(existing, true, requireWrite);
            } catch (KnoteException exception) {
                if (ErrorCodes.IO_ERROR.equals(exception.getCode())) {
                    throw exception;
                }
            }
        }

        String grantId;
        try {
            grantId = existing == null ? newGrantId(records) : existing.grantId;
        } catch (OutOfMemoryError error) {
            throw new KnoteException(ErrorCodes.IO_ERROR, "Could not allocate a grant identifier");
        } catch (RuntimeException error) {
            throw new KnoteException(ErrorCodes.IO_ERROR, "Could not allocate a grant identifier");
        }
        GrantRecord updated = new GrantRecord(
            grantId,
            kind,
            uriText,
            PathPolicy.safeDisplayName(
                pickedMetadata.displayName == null ? displayName : pickedMetadata.displayName,
                kind.equals("tree") ? "Folder" : "Document"
            )
        );

        if (!commitRecord(updated)) {
            if (!restoreRecord(existing, grantId)) {
                throw new KnoteException(ErrorCodes.IO_ERROR, "Could not restore grant record after persistence failure");
            }
            throw new KnoteException(ErrorCodes.IO_ERROR, "Could not persist grant record");
        }
        GrantAccess access;
        try {
            access = reconcile(updated, true, requireWrite);
        } catch (KnoteException exception) {
            if (!restoreRecord(existing, grantId)) {
                throw new KnoteException(ErrorCodes.IO_ERROR, "Could not restore grant record after validation failure");
            }
            throw exception;
        }
        boolean cleanupRequired = false;
        boolean cleaned = true;
        try {
            SharedPreferences.Editor cleanup = preferences.edit();
            for (GrantRecord record : records) {
                if (record.uri.equals(uriText) && !record.grantId.equals(grantId)) {
                    cleanup.remove(RECORD_PREFIX + record.grantId);
                    cleanupRequired = true;
                }
            }
            cleaned = !cleanupRequired || cleanup.commit();
        } catch (OutOfMemoryError | RuntimeException exception) {
            cleaned = false;
        }
        if (!cleaned) {
            if (!restoreRecord(existing, grantId)) {
                throw new KnoteException(ErrorCodes.IO_ERROR, "Could not restore grant record after cleanup failure");
            }
            throw new KnoteException(ErrorCodes.IO_ERROR, "Could not remove duplicate grant records");
        }
        return access;
    }

    synchronized int persistedFlags(Uri uri) throws KnoteException {
        PermissionState permission = findPermission(uri);
        return permission == null ? 0 : permission.toFlags();
    }

    synchronized void rollbackNewlyPersistedModes(Uri uri, int previousFlags) throws KnoteException {
        int currentFlags = persistedFlags(uri);
        int newFlags = currentFlags & ~previousFlags;
        if (newFlags == 0) {
            return;
        }
        try {
            resolver.releasePersistableUriPermission(uri, newFlags);
        } catch (OutOfMemoryError | RuntimeException ignored) {
            // Verify below because a provider may release access before reporting failure.
        }
        if ((persistedFlags(uri) & newFlags) != 0) {
            throw new KnoteException(ErrorCodes.IO_ERROR, "Newly persisted permission modes remain after rollback");
        }
    }

    private void validatePickedUri(Uri uri, String kind) throws KnoteException {
        boolean valid;
        try {
            valid = kind.equals("tree")
                ? DocumentsContract.isTreeUri(uri)
                : DocumentsContract.isDocumentUri(context, uri) && !DocumentsContract.isTreeUri(uri);
        } catch (OutOfMemoryError error) {
            throw new KnoteException(ErrorCodes.IO_ERROR, "Picker URI exceeded memory limits");
        } catch (RuntimeException exception) {
            valid = false;
        }
        if (!valid) {
            throw new KnoteException(ErrorCodes.IO_ERROR, "Picker did not return a compatible document URI");
        }
    }

    private RootMetadata queryPickedMetadata(Uri uri, String kind) throws KnoteException {
        DocumentFile root;
        try {
            root = kind.equals("tree")
                ? DocumentFile.fromTreeUri(context, uri)
                : DocumentFile.fromSingleUri(context, uri);
        } catch (OutOfMemoryError error) {
            throw new KnoteException(ErrorCodes.IO_ERROR, "Picker URI exceeded memory limits");
        } catch (RuntimeException exception) {
            throw new KnoteException(ErrorCodes.IO_ERROR, "Picker returned an invalid document URI");
        }
        if (root == null) {
            throw new KnoteException(ErrorCodes.IO_ERROR, "Picker returned an invalid document URI");
        }
        Uri rootUri;
        try {
            rootUri = root.getUri();
        } catch (OutOfMemoryError error) {
            throw new KnoteException(ErrorCodes.IO_ERROR, "Picker URI exceeded memory limits");
        } catch (RuntimeException exception) {
            throw new KnoteException(ErrorCodes.IO_ERROR, "Picker returned an invalid document URI");
        }
        RootMetadata metadata = queryRootMetadata(rootUri);
        if (kind.equals("tree") != metadata.directory) {
            throw new KnoteException(ErrorCodes.TYPE_MISMATCH, "Picker returned the wrong document type");
        }
        return metadata;
    }

    synchronized GrantAccess require(String grantId, boolean read, boolean write) throws KnoteException {
        GrantRecord record = readRecord(grantId);
        if (record == null) {
            throw new KnoteException(ErrorCodes.BAD_GRANT, "Unknown grant");
        }
        return reconcile(record, read, write);
    }

    synchronized List<GrantAccess> listValid() throws KnoteException {
        List<GrantAccess> valid = new ArrayList<>();
        List<GrantRecord> records = readRecords();
        Map<String, GrantAccess> byUri = new java.util.HashMap<>();
        for (GrantRecord record : records) {
            try {
                GrantAccess access = reconcile(record, true, false);
                GrantAccess existing = byUri.get(record.uri);
                if (existing == null || access.record.grantId.compareTo(existing.record.grantId) < 0) {
                    byUri.put(record.uri, access);
                }
            } catch (KnoteException ignored) {
                if (ErrorCodes.IO_ERROR.equals(ignored.getCode())) {
                    throw ignored;
                }
                // Invalid records remain so restore can distinguish a revoked grant.
            }
        }
        valid.addAll(byUri.values());
        Collections.sort(valid, Comparator.comparing(access -> access.record.grantId));
        return valid;
    }

    synchronized void release(String grantId) throws KnoteException {
        GrantRecord record = readRecord(grantId);
        if (record == null) {
            throw new KnoteException(ErrorCodes.BAD_GRANT, "Unknown grant");
        }

        Uri uri;
        try {
            uri = Uri.parse(record.uri);
        } catch (OutOfMemoryError error) {
            throw new KnoteException(ErrorCodes.IO_ERROR, "Stored grant exceeded memory limits");
        } catch (RuntimeException exception) {
            dropRecord(grantId);
            throw new KnoteException(ErrorCodes.BAD_GRANT, "Stored grant is malformed");
        }
        if (!isExpectedUriKind(uri, record.kind)) {
            dropRecord(grantId);
            throw new KnoteException(ErrorCodes.BAD_GRANT, "Stored grant URI has the wrong kind");
        }
        for (GrantRecord other : readRecords()) {
            if (!other.grantId.equals(grantId) && other.uri.equals(record.uri)) {
                dropRecord(grantId);
                return;
            }
        }
        PermissionState permission = findPermission(uri);
        if (permission != null) {
            int flags = permission.toFlags();
            try {
                if (flags != 0) {
                    resolver.releasePersistableUriPermission(uri, flags);
                }
            } catch (OutOfMemoryError error) {
                throw new KnoteException(ErrorCodes.IO_ERROR, "Persisted permission release exceeded memory limits");
            } catch (RuntimeException exception) {
                // Re-query below because providers can revoke between calls.
            }
        }
        if (permission == null) {
            dropRecord(grantId);
            return;
        }
        PermissionState remaining = findPermission(uri);
        if (remaining != null && remaining.toFlags() != 0) {
            throw new KnoteException(ErrorCodes.IO_ERROR, "Persisted permission is still present");
        }
        dropRecord(grantId);
    }

    synchronized void forgetDeletedDocument(GrantAccess access) throws KnoteException {
        if (access == null || !"document".equals(access.record.kind)) {
            throw new KnoteException(ErrorCodes.BAD_GRANT, "Standalone document grant is required");
        }
        boolean permissionReleased = false;
        try {
            PermissionState permission = findPermission(access.uri);
            if (permission == null || permission.toFlags() == 0) {
                permissionReleased = true;
            } else {
                int flags = permission.toFlags();
                try {
                    resolver.releasePersistableUriPermission(access.uri, flags);
                } catch (OutOfMemoryError | RuntimeException ignored) {
                    // Re-query because deleting the document may already have revoked the grant.
                }
                PermissionState remaining = findPermission(access.uri);
                permissionReleased = remaining == null || (remaining.toFlags() & flags) == 0;
            }
        } catch (OutOfMemoryError | RuntimeException | KnoteException exception) {
            permissionReleased = false;
        }
        if (!permissionReleased) {
            throw new KnoteException(
                ErrorCodes.MUTATION_COMMIT_UNCERTAIN,
                "Document was deleted but persisted permission cleanup could not be verified"
            );
        }

        boolean forgotten = false;
        try {
            SharedPreferences.Editor editor = preferences.edit().remove(RECORD_PREFIX + access.record.grantId);
            for (GrantRecord record : readRecords()) {
                if (record.uri.equals(access.record.uri)) {
                    editor.remove(RECORD_PREFIX + record.grantId);
                }
            }
            forgotten = editor.commit();
        } catch (OutOfMemoryError | RuntimeException | KnoteException exception) {
            forgotten = false;
        }
        if (!forgotten) {
            throw new KnoteException(
                ErrorCodes.MUTATION_COMMIT_UNCERTAIN,
                "Document was deleted but grant cleanup could not be verified"
            );
        }
    }

    private GrantAccess reconcile(GrantRecord record, boolean requireRead, boolean requireWrite) throws KnoteException {
        Uri uri;
        try {
            uri = Uri.parse(record.uri);
        } catch (OutOfMemoryError error) {
            throw new KnoteException(ErrorCodes.IO_ERROR, "Stored grant exceeded memory limits");
        } catch (RuntimeException exception) {
            throw new KnoteException(ErrorCodes.BAD_GRANT, "Stored grant is malformed");
        }
        if (!isExpectedUriKind(uri, record.kind)) {
            throw new KnoteException(ErrorCodes.BAD_GRANT, "Stored grant URI has the wrong kind");
        }
        PermissionState permission = findPermission(uri);
        if (permission == null || (requireRead && !permission.readable)) {
            throw new KnoteException(ErrorCodes.GRANT_REVOKED, "Persisted permission is missing or revoked");
        }
        if (requireWrite && !permission.writable) {
            throw new KnoteException(ErrorCodes.READ_ONLY, "Grant is read-only");
        }

        DocumentFile root;
        try {
            root = record.kind.equals("tree")
                ? DocumentFile.fromTreeUri(context, uri)
                : DocumentFile.fromSingleUri(context, uri);
            if (root == null) {
                throw new KnoteException(ErrorCodes.BAD_GRANT, "Stored grant is malformed");
            }
        } catch (KnoteException exception) {
            throw exception;
        } catch (OutOfMemoryError error) {
            throw new KnoteException(ErrorCodes.IO_ERROR, "Stored grant exceeded memory limits");
        } catch (SecurityException exception) {
            throw new KnoteException(ErrorCodes.GRANT_REVOKED, "Persisted permission is missing or revoked");
        } catch (IllegalArgumentException exception) {
            throw new KnoteException(ErrorCodes.BAD_GRANT, "Stored grant is malformed");
        } catch (RuntimeException exception) {
            throw new KnoteException(ErrorCodes.IO_ERROR, "Stored grant could not be opened");
        }

        Uri rootUri;
        try {
            rootUri = root.getUri();
        } catch (OutOfMemoryError error) {
            throw new KnoteException(ErrorCodes.IO_ERROR, "Stored grant exceeded memory limits");
        } catch (RuntimeException exception) {
            throw new KnoteException(ErrorCodes.IO_ERROR, "Stored grant could not be opened");
        }
        RootMetadata metadata = queryRootMetadata(rootUri);
        if (record.kind.equals("tree") && !metadata.directory) {
            throw new KnoteException(ErrorCodes.TYPE_MISMATCH, "Tree grant no longer points to a directory");
        }
        if (record.kind.equals("document") && metadata.directory) {
            throw new KnoteException(ErrorCodes.TYPE_MISMATCH, "Document grant points to a directory");
        }
        String safeName = PathPolicy.safeDisplayName(
            metadata.displayName,
            record.kind.equals("tree") ? "Folder" : "Document"
        );
        GrantRecord current = record;
        if (!safeName.equals(record.displayName)) {
            GrantRecord candidate = new GrantRecord(record.grantId, record.kind, record.uri, safeName);
            current = candidate;
            try {
                preferences.edit().putString(RECORD_PREFIX + record.grantId, candidate.toJson().toString()).commit();
            } catch (OutOfMemoryError | RuntimeException ignored) {}
        }
        boolean readable = permission.readable;
        boolean writable = permission.writable;
        return new GrantAccess(current, uri, root, readable, writable);
    }

    private RootMetadata queryRootMetadata(Uri uri) throws KnoteException {
        if (uri == null) {
            throw new KnoteException(ErrorCodes.BAD_GRANT, "Stored grant URI is invalid");
        }
        if (
            !"content".equals(uri.getScheme()) ||
            uri.getAuthority() == null ||
            uri.getAuthority().isEmpty() ||
            uri.getAuthority().length() > 255
        ) {
            throw new KnoteException(ErrorCodes.BAD_GRANT, "Stored grant URI is invalid");
        }
        String uriText;
        try {
            uriText = uri.toString();
        } catch (OutOfMemoryError error) {
            throw new KnoteException(ErrorCodes.IO_ERROR, "Stored grant URI exceeded memory limits");
        } catch (RuntimeException exception) {
            throw new KnoteException(ErrorCodes.BAD_GRANT, "Stored grant URI is invalid");
        }
        if (uriText.length() > MAX_URI_LENGTH) {
            throw new KnoteException(ErrorCodes.BAD_GRANT, "Stored grant URI is oversized");
        }
        String[] projection = {
            DocumentsContract.Document.COLUMN_DISPLAY_NAME,
            DocumentsContract.Document.COLUMN_MIME_TYPE,
            DocumentsContract.Document.COLUMN_FLAGS,
        };
        try (Cursor cursor = resolver.query(uri, projection, null, null, null)) {
            if (cursor == null) {
                throw new KnoteException(ErrorCodes.IO_ERROR, "Document provider did not return grant metadata");
            }
            checkGrantMetadataExtras(cursor.getExtras());
            int count = cursor.getCount();
            if (count == 0) {
                throw new KnoteException(ErrorCodes.NOT_FOUND, "Granted document no longer exists");
            }
            if (count != 1) {
                throw new KnoteException(ErrorCodes.IO_ERROR, "Document provider returned ambiguous grant metadata");
            }
            if (!cursor.moveToFirst()) {
                throw new KnoteException(ErrorCodes.NOT_FOUND, "Granted document no longer exists");
            }
            checkGrantMetadataExtras(cursor.getExtras());
            String displayName = cursor.isNull(0) ? null : cursor.getString(0);
            String mimeType = cursor.isNull(1) ? null : cursor.getString(1);
            long flags = cursor.isNull(2) ? 0 : cursor.getLong(2);
            checkGrantMetadataExtras(cursor.getExtras());
            if (mimeType == null || mimeType.isEmpty()) {
                throw new KnoteException(ErrorCodes.TYPE_MISMATCH, "Granted document has no MIME type");
            }
            if (mimeType.length() > 127) {
                throw new KnoteException(ErrorCodes.IO_ERROR, "Document provider returned oversized grant metadata");
            }
            if (displayName != null && displayName.length() > 4096) {
                displayName = displayName.substring(0, 4096);
                if (
                    !displayName.isEmpty() &&
                    Character.isHighSurrogate(displayName.charAt(displayName.length() - 1))
                ) {
                    displayName = displayName.substring(0, displayName.length() - 1);
                }
            }
            return new RootMetadata(
                displayName,
                DocumentsContract.Document.MIME_TYPE_DIR.equals(mimeType),
                (flags & DocumentsContract.Document.FLAG_SUPPORTS_WRITE) != 0
            );
        } catch (KnoteException exception) {
            throw exception;
        } catch (OutOfMemoryError error) {
            throw new KnoteException(ErrorCodes.IO_ERROR, "Document provider metadata exceeded memory limits");
        } catch (SecurityException exception) {
            throw new KnoteException(ErrorCodes.GRANT_REVOKED, "Persisted permission is missing or revoked");
        } catch (RuntimeException exception) {
            throw new KnoteException(ErrorCodes.IO_ERROR, "Document provider metadata query failed");
        }
    }

    private static void checkGrantMetadataExtras(Bundle extras) throws KnoteException {
        if (extras == null) {
            return;
        }
        String error = extras.getString(DocumentsContract.EXTRA_ERROR);
        if (error != null && !error.isEmpty()) {
            throw new KnoteException(ErrorCodes.IO_ERROR, "Document provider reported a grant metadata error");
        }
        if (extras.getBoolean(DocumentsContract.EXTRA_LOADING, false)) {
            throw new KnoteException(ErrorCodes.IO_ERROR, "Document provider grant metadata is incomplete");
        }
    }

    private boolean isExpectedUriKind(Uri uri, String kind) {
        if (uri == null || kind == null) {
            return false;
        }
        try {
            return kind.equals("tree")
                ? DocumentsContract.isTreeUri(uri)
                : DocumentsContract.isDocumentUri(context, uri) && !DocumentsContract.isTreeUri(uri);
        } catch (OutOfMemoryError error) {
            return false;
        } catch (RuntimeException exception) {
            return false;
        }
    }

    private PermissionState findPermission(Uri uri) throws KnoteException {
        if (uri == null) {
            return null;
        }
        boolean readable = false;
        boolean writable = false;
        boolean found = false;
        try {
            List<UriPermission> permissions = resolver.getPersistedUriPermissions();
            if (permissions == null) {
                throw new KnoteException(ErrorCodes.IO_ERROR, "Persisted permissions could not be queried");
            }
            for (UriPermission permission : permissions) {
                if (permission != null && uri.equals(permission.getUri())) {
                    found = true;
                    readable |= permission.isReadPermission();
                    writable |= permission.isWritePermission();
                }
            }
        } catch (KnoteException exception) {
            throw exception;
        } catch (OutOfMemoryError error) {
            throw new KnoteException(ErrorCodes.IO_ERROR, "Persisted permissions exceeded memory limits");
        } catch (RuntimeException exception) {
            throw new KnoteException(ErrorCodes.IO_ERROR, "Persisted permissions could not be queried");
        }
        return found ? new PermissionState(readable, writable) : null;
    }

    private GrantRecord readRecord(String grantId) throws KnoteException {
        if (!isGrantId(grantId)) {
            return null;
        }
        String value;
        try {
            value = preferences.getString(RECORD_PREFIX + grantId, null);
        } catch (OutOfMemoryError error) {
            throw new KnoteException(ErrorCodes.IO_ERROR, "Grant records exceeded memory limits");
        } catch (RuntimeException error) {
            throw new KnoteException(ErrorCodes.IO_ERROR, "Grant records could not be read");
        }
        if (value == null) {
            return null;
        }
        if (value.length() > MAX_URI_LENGTH + 4096) {
            dropRecord(grantId);
            return null;
        }
        try {
            GrantRecord record = GrantRecord.fromJson(new JSONObject(value));
            if (grantId.equals(record.grantId)) {
                return record;
            }
        } catch (JSONException | IllegalArgumentException exception) {
        } catch (OutOfMemoryError error) {
            throw new KnoteException(ErrorCodes.IO_ERROR, "Stored grant exceeded memory limits");
        } catch (RuntimeException exception) {
        }
        dropRecord(grantId);
        return null;
    }

    private List<GrantRecord> readRecords() throws KnoteException {
        List<GrantRecord> records = new ArrayList<>();
        Map<String, ?> values;
        try {
            values = preferences.getAll();
        } catch (OutOfMemoryError error) {
            throw new KnoteException(ErrorCodes.IO_ERROR, "Grant records exceeded memory limits");
        } catch (RuntimeException exception) {
            throw new KnoteException(ErrorCodes.IO_ERROR, "Grant records could not be read");
        }
        try {
            List<Map.Entry<String, ?>> entries = new ArrayList<>(values.entrySet());
            entries.sort((left, right) -> {
                String leftKey = left == null ? "" : left.getKey();
                String rightKey = right == null ? "" : right.getKey();
                if (leftKey == null) {
                    leftKey = "";
                }
                if (rightKey == null) {
                    rightKey = "";
                }
                return leftKey.compareTo(rightKey);
            });
            for (Map.Entry<String, ?> entry : entries) {
                if (entry == null || entry.getKey() == null || !entry.getKey().startsWith(RECORD_PREFIX)) {
                    continue;
                }
                if (!(entry.getValue() instanceof String)) {
                    dropRecordKey(entry.getKey());
                    continue;
                }
                if (records.size() >= 1024) {
                    dropRecordKey(entry.getKey());
                    continue;
                }
                if (((String) entry.getValue()).length() > MAX_URI_LENGTH + 4096) {
                    dropRecordKey(entry.getKey());
                    continue;
                }
                try {
                    GrantRecord record = GrantRecord.fromJson(new JSONObject((String) entry.getValue()));
                    if (entry.getKey().equals(RECORD_PREFIX + record.grantId) && isGrantId(record.grantId)) {
                        records.add(record);
                    } else {
                        dropRecordKey(entry.getKey());
                    }
                } catch (JSONException | IllegalArgumentException ignored) {
                    dropRecordKey(entry.getKey());
                } catch (OutOfMemoryError ignored) {
                    throw new KnoteException(ErrorCodes.IO_ERROR, "Grant records exceeded memory limits");
                } catch (RuntimeException ignored) {
                    dropRecordKey(entry.getKey());
                }
            }
        } catch (OutOfMemoryError error) {
            throw new KnoteException(ErrorCodes.IO_ERROR, "Grant records exceeded memory limits");
        } catch (RuntimeException error) {
            throw new KnoteException(ErrorCodes.IO_ERROR, "Grant records could not be read");
        }
        return records;
    }

    private boolean commitRecord(GrantRecord record) {
        try {
            return preferences.edit()
                .putString(RECORD_PREFIX + record.grantId, record.toJson().toString())
                .commit();
        } catch (OutOfMemoryError | RuntimeException exception) {
            return false;
        }
    }

    private boolean restoreRecord(GrantRecord existing, String grantId) {
        try {
            return existing == null
                ? preferences.edit().remove(RECORD_PREFIX + grantId).commit()
                : commitRecord(existing);
        } catch (OutOfMemoryError | RuntimeException exception) {
            return false;
        }
    }

    private void dropRecord(String grantId) throws KnoteException {
        dropRecordKey(RECORD_PREFIX + grantId);
    }

    private void dropRecordKey(String key) throws KnoteException {
        boolean removed;
        try {
            removed = preferences.edit().remove(key).commit();
        } catch (OutOfMemoryError | RuntimeException exception) {
            removed = false;
        }
        if (!removed) {
            throw new KnoteException(ErrorCodes.IO_ERROR, "Could not forget grant record");
        }
    }

    private String newGrantId(List<GrantRecord> records) {
        for (int attempt = 0; attempt < 128; attempt++) {
            byte[] random = new byte[GRANT_ID_BYTES];
            secureRandom.nextBytes(random);
            String candidate = Base64.encodeToString(random, Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING);
            boolean collision = false;
            for (GrantRecord record : records) {
                if (record.grantId.equals(candidate)) {
                    collision = true;
                    break;
                }
            }
            if (!collision && !preferences.contains(RECORD_PREFIX + candidate)) {
                return candidate;
            }
        }
        throw new IllegalStateException("Could not allocate a grant identifier");
    }

    private static boolean isGrantId(String value) {
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

    static final class GrantAccess {
        final GrantRecord record;
        final Uri uri;
        final DocumentFile root;
        final boolean readable;
        final boolean writable;

        GrantAccess(GrantRecord record, Uri uri, DocumentFile root, boolean readable, boolean writable) {
            this.record = record;
            this.uri = uri;
            this.root = root;
            this.readable = readable;
            this.writable = writable;
        }

        JSObject toJsObject() {
            return new JSObject()
                .put("grantId", record.grantId)
                .put("kind", record.kind)
                .put("displayName", record.displayName)
                .put("writable", writable)
                .put("readable", readable)
                .put("persisted", true)
                .put("valid", true);
        }
    }

    static final class GrantRecord {
        final String grantId;
        final String kind;
        final String uri;
        final String displayName;

        GrantRecord(String grantId, String kind, String uri, String displayName) {
            if (kind == null || (!kind.equals("tree") && !kind.equals("document"))) {
                throw new IllegalArgumentException("Invalid grant kind");
            }
            if (grantId == null || uri == null || displayName == null) {
                throw new IllegalArgumentException("Incomplete grant record");
            }
            this.grantId = grantId;
            this.kind = kind;
            this.uri = uri;
            this.displayName = displayName;
        }

        JSONObject toJson() {
            JSONObject value = new JSONObject();
            try {
                value.put("grantId", grantId);
                value.put("kind", kind);
                value.put("uri", uri);
                value.put("displayName", displayName);
            } catch (JSONException exception) {
                throw new IllegalStateException(exception);
            }
            return value;
        }

        static GrantRecord fromJson(JSONObject value) throws JSONException {
            if (value.length() != 4) {
                throw new IllegalArgumentException("Invalid grant record");
            }
            String grantId = value.getString("grantId");
            String kind = value.getString("kind");
            String uri = value.getString("uri");
            String displayName = value.getString("displayName");
            Uri parsed = Uri.parse(uri);
            if (
                !"content".equals(parsed.getScheme()) ||
                parsed.getAuthority() == null ||
                parsed.getAuthority().isEmpty() ||
                parsed.getAuthority().length() > 255 ||
                uri.length() > MAX_URI_LENGTH ||
                displayName.isEmpty() ||
                displayName.length() > 1024 ||
                value.isNull("grantId") ||
                value.isNull("kind") ||
                value.isNull("uri") ||
                value.isNull("displayName")
            ) {
                throw new IllegalArgumentException("Invalid grant record");
            }
            for (int offset = 0; offset < displayName.length();) {
                char unit = displayName.charAt(offset);
                if (Character.isHighSurrogate(unit)) {
                    if (offset + 1 >= displayName.length() || !Character.isLowSurrogate(displayName.charAt(offset + 1))) {
                        throw new IllegalArgumentException("Invalid grant display name");
                    }
                } else if (Character.isLowSurrogate(unit)) {
                    throw new IllegalArgumentException("Invalid grant display name");
                }
                int codePoint = displayName.codePointAt(offset);
                if (PathPolicy.isForbiddenCodePoint(codePoint)) {
                    throw new IllegalArgumentException("Invalid grant display name");
                }
                offset += Character.charCount(codePoint);
            }
            return new GrantRecord(grantId, kind, uri, displayName);
        }
    }

    private static final class PermissionState {
        final boolean readable;
        final boolean writable;

        PermissionState(boolean readable, boolean writable) {
            this.readable = readable;
            this.writable = writable;
        }

        int toFlags() {
            int flags = 0;
            if (readable) {
                flags |= android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION;
            }
            if (writable) {
                flags |= android.content.Intent.FLAG_GRANT_WRITE_URI_PERMISSION;
            }
            return flags;
        }
    }

    private static final class RootMetadata {
        final String displayName;
        final boolean directory;
        final boolean supportsWrite;

        RootMetadata(String displayName, boolean directory, boolean supportsWrite) {
            this.displayName = displayName;
            this.directory = directory;
            this.supportsWrite = supportsWrite;
        }
    }
}
