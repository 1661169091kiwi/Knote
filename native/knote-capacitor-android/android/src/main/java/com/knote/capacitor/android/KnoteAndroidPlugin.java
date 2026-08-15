package com.knote.capacitor.android;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.ContentResolver;
import android.content.Intent;
import android.net.Uri;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.atomic.AtomicBoolean;
import org.json.JSONArray;
import org.json.JSONObject;

@CapacitorPlugin(name = "KnoteAndroid")
public final class KnoteAndroidPlugin extends Plugin {
    private static final int READ_FLAG = Intent.FLAG_GRANT_READ_URI_PERMISSION;
    private static final int WRITE_FLAG = Intent.FLAG_GRANT_WRITE_URI_PERMISSION;
    private static final int PERSISTABLE_FLAG = Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION;
    private static final int PREFIX_FLAG = Intent.FLAG_GRANT_PREFIX_URI_PERMISSION;

    private GrantStore grants;
    private EntryStore entries;
    private SafService saf;
    private WebSearchService webSearch;
    private ExecutorService searchExecutor;
    private final AtomicBoolean pickerInFlight = new AtomicBoolean();

    @Override
    public void load() {
        grants = new GrantStore(getContext());
        entries = new EntryStore();
        saf = new SafService(getContext(), grants, entries);
        webSearch = new WebSearchService();
        searchExecutor = Executors.newSingleThreadExecutor();
    }

    @Override
    protected void handleOnDestroy() {
        pickerInFlight.set(false);
        if (webSearch != null) {
            webSearch.cancelActive();
        }
        if (searchExecutor != null) {
            searchExecutor.shutdownNow();
        }
        if (entries != null) {
            entries.clear();
        }
    }

    @PluginMethod
    public void pickDocument(PluginCall call) {
        if (!isLoaded(call)) {
            return;
        }
        try {
            boolean writable = optionalBoolean(call, "writable", true);
            List<String> mimeTypes = optionalMimeTypes(call);
            Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE);
            if (mimeTypes.isEmpty()) {
                intent.setType("*/*");
            } else if (mimeTypes.size() == 1) {
                intent.setType(mimeTypes.get(0));
            } else {
                intent.setType("*/*");
                intent.putExtra(Intent.EXTRA_MIME_TYPES, mimeTypes.toArray(new String[0]));
            }
            int flags = READ_FLAG | PERSISTABLE_FLAG | (writable ? WRITE_FLAG : 0);
            intent.addFlags(flags);
            launchPicker(call, intent, "pickDocumentResult");
        } catch (KnoteException exception) {
            reject(call, exception);
        } catch (OutOfMemoryError error) {
            call.reject("Native operation exceeded memory limits", ErrorCodes.IO_ERROR);
        } catch (RuntimeException exception) {
            call.reject("Could not prepare document picker", ErrorCodes.IO_ERROR);
        }
    }

    @PluginMethod
    public void createDocument(PluginCall call) {
        if (!isLoaded(call)) {
            return;
        }
        try {
            String inputName = requiredString(call, "suggestedName");
            String suggestedName = PathPolicy.requireCanonicalName(inputName);
            String mimeType = optionalString(call, "mimeType", "application/octet-stream");
            mimeType = MimePolicy.validate(mimeType, false);
            Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT)
                .addCategory(Intent.CATEGORY_OPENABLE)
                .setType(mimeType)
                .putExtra(Intent.EXTRA_TITLE, suggestedName)
                .addFlags(READ_FLAG | WRITE_FLAG | PERSISTABLE_FLAG);
            launchPicker(call, intent, "createDocumentResult");
        } catch (KnoteException exception) {
            reject(call, exception);
        } catch (OutOfMemoryError error) {
            call.reject("Native operation exceeded memory limits", ErrorCodes.IO_ERROR);
        } catch (RuntimeException exception) {
            call.reject("Could not prepare document picker", ErrorCodes.IO_ERROR);
        }
    }

    @PluginMethod
    public void pickTree(PluginCall call) {
        if (!isLoaded(call)) {
            return;
        }
        try {
            boolean writable = optionalBoolean(call, "writable", true);
            Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE).addFlags(
                READ_FLAG | PERSISTABLE_FLAG | PREFIX_FLAG | (writable ? WRITE_FLAG : 0)
            );
            launchPicker(call, intent, "pickTreeResult");
        } catch (KnoteException exception) {
            reject(call, exception);
        } catch (OutOfMemoryError error) {
            call.reject("Native operation exceeded memory limits", ErrorCodes.IO_ERROR);
        } catch (RuntimeException exception) {
            call.reject("Could not prepare document picker", ErrorCodes.IO_ERROR);
        }
    }

    @ActivityCallback
    private void pickDocumentResult(PluginCall call, ActivityResult result) {
        finishPicker(call, result, "document", call != null && call.getBoolean("writable", true), false);
    }

    @ActivityCallback
    private void createDocumentResult(PluginCall call, ActivityResult result) {
        finishPicker(call, result, "document", true, false);
    }

    @ActivityCallback
    private void pickTreeResult(PluginCall call, ActivityResult result) {
        finishPicker(call, result, "tree", call != null && call.getBoolean("writable", true), true);
    }

    @PluginMethod
    public void listGrants(PluginCall call) {
        if (!isLoaded(call)) {
            return;
        }
        run(call, () -> {
            JSArray output = new JSArray();
            for (GrantStore.GrantAccess access : grants.listValid()) {
                output.put(access.toJsObject());
            }
            return new JSObject().put("grants", output);
        });
    }

    @PluginMethod
    public void restoreGrant(PluginCall call) {
        if (!isLoaded(call)) {
            return;
        }
        run(call, () -> grants.require(requiredString(call, "grantId"), true, false).toJsObject());
    }

    @PluginMethod
    public void releaseGrant(PluginCall call) {
        if (!isLoaded(call)) {
            return;
        }
        runVoid(call, () -> {
            String grantId = requiredString(call, "grantId");
            grants.release(grantId);
            entries.forgetGrant(grantId);
        });
    }

    @PluginMethod
    public void list(PluginCall call) {
        if (!isLoaded(call)) {
            return;
        }
        run(
            call,
            () -> new JSObject().put(
                "entries",
                saf.list(
                    requiredString(call, "grantId"),
                    requiredString(call, "relativePath"),
                    optionalNullableString(call, "entryId")
                )
            )
        );
    }

    @PluginMethod
    public void stat(PluginCall call) {
        if (!isLoaded(call)) {
            return;
        }
        run(
            call,
            () -> saf.stat(
                requiredString(call, "grantId"),
                requiredString(call, "relativePath"),
                optionalNullableString(call, "entryId"),
                optionalNullableString(call, "parentEntryId")
            )
        );
    }

    @PluginMethod
    public void readFile(PluginCall call) {
        if (!isLoaded(call)) {
            return;
        }
        run(
            call,
            () -> saf.readFile(
                requiredString(call, "grantId"),
                requiredString(call, "relativePath"),
                optionalNullableString(call, "entryId")
            )
        );
    }

    @PluginMethod
    public void writeFile(PluginCall call) {
        if (!isLoaded(call)) {
            return;
        }
        run(
            call,
            () -> saf.writeFile(
                requiredString(call, "grantId"),
                requiredString(call, "relativePath"),
                optionalNullableString(call, "entryId"),
                requiredString(call, "data")
            )
        );
    }

    @PluginMethod
    public void createFile(PluginCall call) {
        if (!isLoaded(call)) {
            return;
        }
        run(
            call,
            () -> saf.createFile(
                requiredString(call, "grantId"),
                requiredString(call, "relativePath"),
                optionalNullableString(call, "parentEntryId"),
                optionalNullableString(call, "mimeType")
            )
        );
    }

    @PluginMethod
    public void createDirectory(PluginCall call) {
        if (!isLoaded(call)) {
            return;
        }
        run(
            call,
            () -> saf.createDirectory(
                requiredString(call, "grantId"),
                requiredString(call, "relativePath"),
                optionalNullableString(call, "parentEntryId")
            )
        );
    }

    @PluginMethod
    public void rename(PluginCall call) {
        if (!isLoaded(call)) {
            return;
        }
        run(
            call,
            () -> saf.rename(
                requiredString(call, "grantId"),
                requiredString(call, "relativePath"),
                requiredString(call, "entryId"),
                requiredString(call, "newName")
            )
        );
    }

    @PluginMethod
    public void move(PluginCall call) {
        if (!isLoaded(call)) {
            return;
        }
        run(
            call,
            () -> saf.move(
                requiredString(call, "grantId"),
                requiredString(call, "relativePath"),
                requiredString(call, "destinationPath"),
                requiredString(call, "entryId"),
                optionalNullableString(call, "destinationEntryId")
            )
        );
    }

    @PluginMethod
    public void delete(PluginCall call) {
        if (!isLoaded(call)) {
            return;
        }
        runVoid(
            call,
            () -> saf.delete(
                requiredString(call, "grantId"),
                requiredString(call, "relativePath"),
                optionalNullableString(call, "entryId"),
                optionalBoolean(call, "recursive", false)
            )
        );
    }

    @PluginMethod
    public void webSearch(PluginCall call) {
        if (!isLoaded(call)) {
            return;
        }
        try {
            long requestEpoch = webSearch.beginRequest();
            searchExecutor.execute(
                () -> run(
                    call,
                    () -> webSearch.search(
                        requiredString(call, "query"),
                        optionalInteger(call, "max", 10),
                        optionalString(call, "engine", "auto"),
                        optionalString(call, "region", ""),
                        requestEpoch
                    )
                )
            );
        } catch (RejectedExecutionException exception) {
            call.reject("Search service is unavailable", ErrorCodes.IO_ERROR);
        }
    }

    @PluginMethod
    public void cancelWebSearch(PluginCall call) {
        if (!isLoaded(call)) {
            return;
        }
        webSearch.cancelActive();
        call.resolve();
    }

    private void launchPicker(PluginCall call, Intent intent, String callback) {
        if (call == null) {
            return;
        }
        if (!pickerInFlight.compareAndSet(false, true)) {
            call.reject("A document picker is already open", ErrorCodes.UNSUPPORTED_OPERATION);
            return;
        }
        try {
            startActivityForResult(call, intent, callback);
        } catch (ActivityNotFoundException exception) {
            pickerInFlight.set(false);
            call.reject("No compatible document picker is available", ErrorCodes.UNSUPPORTED_OPERATION);
        } catch (SecurityException exception) {
            pickerInFlight.set(false);
            call.reject("Document picker could not be opened", ErrorCodes.IO_ERROR);
        } catch (OutOfMemoryError error) {
            pickerInFlight.set(false);
            call.reject("Could not open document picker within memory limits", ErrorCodes.IO_ERROR);
        } catch (RuntimeException exception) {
            pickerInFlight.set(false);
            call.reject("Could not open document picker", ErrorCodes.IO_ERROR);
        }
    }

    private void finishPicker(
        PluginCall call,
        ActivityResult result,
        String kind,
        boolean requireWrite,
        boolean requirePrefix
    ) {
        pickerInFlight.set(false);
        if (call == null) {
            return;
        }
        if (result == null) {
            call.reject("Document picker returned no result", ErrorCodes.IO_ERROR);
            return;
        }
        try {
            if (result.getResultCode() == Activity.RESULT_CANCELED) {
                call.reject("Document picker was cancelled", ErrorCodes.PICKER_CANCELLED);
                return;
            }
            if (result.getResultCode() != Activity.RESULT_OK) {
                call.reject("Document picker failed", ErrorCodes.IO_ERROR);
                return;
            }
            Intent data = result.getData();
            Uri uri = data == null ? null : data.getData();
            if (
                uri == null ||
                !ContentResolver.SCHEME_CONTENT.equals(uri.getScheme()) ||
                uri.getAuthority() == null ||
                uri.getAuthority().isEmpty() ||
                uri.toString().length() > 16_384
            ) {
                call.reject("Document picker returned an invalid document", ErrorCodes.IO_ERROR);
                return;
            }

            int requestedFlags = READ_FLAG | (requireWrite ? WRITE_FLAG : 0);
            int returnedFlags = data.getFlags();
            if (
                (returnedFlags & requestedFlags) != requestedFlags ||
                (returnedFlags & PERSISTABLE_FLAG) == 0 ||
                (requirePrefix && (returnedFlags & PREFIX_FLAG) == 0)
            ) {
                call.reject("Document provider did not grant the required access", ErrorCodes.IO_ERROR);
                return;
            }
            try {
                if (requirePrefix && !android.provider.DocumentsContract.isTreeUri(uri)) {
                    call.reject("Document provider did not return a tree URI", ErrorCodes.IO_ERROR);
                    return;
                }
            } catch (OutOfMemoryError error) {
                call.reject("Document provider returned an oversized URI", ErrorCodes.IO_ERROR);
                return;
            } catch (RuntimeException exception) {
                call.reject("Document provider returned an invalid URI", ErrorCodes.IO_ERROR);
                return;
            }
            int persistFlags = returnedFlags & requestedFlags & (READ_FLAG | WRITE_FLAG);
            if ((persistFlags & READ_FLAG) == 0) {
                call.reject("Document provider did not return readable access", ErrorCodes.IO_ERROR);
                return;
            }
            execute(() -> persistPickedGrant(call, uri, kind, persistFlags));
        } catch (OutOfMemoryError error) {
            if (call != null) {
                call.reject("Document picker result exceeded memory limits", ErrorCodes.IO_ERROR);
            }
        } catch (RuntimeException exception) {
            if (call != null) {
                call.reject("Document picker result could not be processed", ErrorCodes.IO_ERROR);
            }
        }
    }

    private void persistPickedGrant(PluginCall call, Uri uri, String kind, int persistFlags) {
        int previousFlags;
        try {
            previousFlags = grants.persistedFlags(uri);
        } catch (KnoteException exception) {
            reject(call, exception);
            return;
        } catch (OutOfMemoryError error) {
            call.reject("Document permission exceeded memory limits", ErrorCodes.IO_ERROR);
            return;
        } catch (RuntimeException exception) {
            call.reject("Document permission could not be inspected", ErrorCodes.IO_ERROR);
            return;
        }

        try {
            getContext().getContentResolver().takePersistableUriPermission(uri, persistFlags);
        } catch (OutOfMemoryError error) {
            rejectPickerPermissionFailure(
                call,
                uri,
                previousFlags,
                "Document permission exceeded memory limits"
            );
            return;
        } catch (SecurityException | IllegalArgumentException | UnsupportedOperationException exception) {
            rejectPickerPermissionFailure(
                call,
                uri,
                previousFlags,
                "Document provider did not persist the required access"
            );
            return;
        } catch (RuntimeException exception) {
            rejectPickerPermissionFailure(
                call,
                uri,
                previousFlags,
                "Document provider could not persist the required access"
            );
            return;
        }

        GrantStore.GrantAccess access;
        try {
            access = grants.savePickedGrant(
                uri,
                kind,
                kind.equals("tree") ? "Folder" : "Document",
                persistFlags
            );
        } catch (KnoteException exception) {
            if (rollbackPickedPermission(call, uri, previousFlags)) {
                reject(call, exception);
            }
            return;
        } catch (OutOfMemoryError error) {
            if (rollbackPickedPermission(call, uri, previousFlags)) {
                call.reject("Document picker result exceeded memory limits", ErrorCodes.IO_ERROR);
            }
            return;
        } catch (RuntimeException exception) {
            if (rollbackPickedPermission(call, uri, previousFlags)) {
                call.reject("Document picker result could not be persisted", ErrorCodes.IO_ERROR);
            }
            return;
        }

        try {
            call.resolve(access.toJsObject());
        } catch (OutOfMemoryError error) {
            call.reject("Persisted grant response exceeded memory limits", ErrorCodes.IO_ERROR);
        } catch (RuntimeException exception) {
            call.reject("Persisted grant response could not be created", ErrorCodes.IO_ERROR);
        }
    }

    private void rejectPickerPermissionFailure(
        PluginCall call,
        Uri uri,
        int previousFlags,
        String message
    ) {
        if (rollbackPickedPermission(call, uri, previousFlags)) {
            call.reject(message, ErrorCodes.IO_ERROR);
        }
    }

    private boolean rollbackPickedPermission(PluginCall call, Uri uri, int previousFlags) {
        try {
            grants.rollbackNewlyPersistedModes(uri, previousFlags);
            return true;
        } catch (KnoteException exception) {
            call.reject("Newly persisted document access could not be rolled back", ErrorCodes.IO_ERROR);
            return false;
        } catch (OutOfMemoryError | RuntimeException exception) {
            call.reject("Document permission rollback failed", ErrorCodes.IO_ERROR);
            return false;
        }
    }

    private List<String> optionalMimeTypes(PluginCall call) throws KnoteException {
        if (call == null || call.getData() == null) {
            throw typeMismatch("Missing call data");
        }
        Object raw = call.getData().opt("mimeTypes");
        if (raw == null || raw == JSONObject.NULL) {
            return Collections.emptyList();
        }
        if (!(raw instanceof JSONArray)) {
            throw typeMismatch("mimeTypes must be an array of MIME type strings");
        }
        JSONArray array = (JSONArray) raw;
        if (array.length() == 0) {
            return Collections.emptyList();
        }
        if (array.length() > MimePolicy.MAX_MIME_TYPES) {
            throw typeMismatch("mimeTypes has an invalid number of values");
        }
        Set<String> unique = new LinkedHashSet<>();
        for (int index = 0; index < array.length(); index++) {
            Object item = array.opt(index);
            if (!(item instanceof String)) {
                throw typeMismatch("mimeTypes must contain only strings");
            }
            unique.add(MimePolicy.validate((String) item, true));
        }
        return new ArrayList<>(unique);
    }

    private static String requiredString(PluginCall call, String name) throws KnoteException {
        if (call == null || call.getData() == null) {
            throw typeMismatch("Missing call data");
        }
        Object value = call.getData().opt(name);
        if (!(value instanceof String)) {
            throw typeMismatch(name + " must be a string");
        }
        return (String) value;
    }

    private static String optionalString(PluginCall call, String name, String defaultValue) throws KnoteException {
        if (call == null || call.getData() == null) {
            throw typeMismatch("Missing call data");
        }
        Object value = call.getData().opt(name);
        if (value == null || value == JSONObject.NULL) {
            return defaultValue;
        }
        if (!(value instanceof String)) {
            throw typeMismatch(name + " must be a string");
        }
        return (String) value;
    }

    private static String optionalNullableString(PluginCall call, String name) throws KnoteException {
        if (call == null || call.getData() == null) {
            throw typeMismatch("Missing call data");
        }
        Object value = call.getData().opt(name);
        if (value == null || value == JSONObject.NULL) {
            return null;
        }
        if (!(value instanceof String)) {
            throw typeMismatch(name + " must be a string");
        }
        return (String) value;
    }

    private static boolean optionalBoolean(PluginCall call, String name, boolean defaultValue) throws KnoteException {
        if (call == null || call.getData() == null) {
            throw typeMismatch("Missing call data");
        }
        Object value = call.getData().opt(name);
        if (value == null || value == JSONObject.NULL) {
            return defaultValue;
        }
        if (!(value instanceof Boolean)) {
            throw typeMismatch(name + " must be a boolean");
        }
        return (Boolean) value;
    }

    private static int optionalInteger(PluginCall call, String name, int defaultValue) throws KnoteException {
        if (call == null || call.getData() == null) {
            throw typeMismatch("Missing call data");
        }
        Object value = call.getData().opt(name);
        if (value == null || value == JSONObject.NULL) {
            return defaultValue;
        }
        if (!(value instanceof Number)) {
            throw typeMismatch(name + " must be an integer");
        }
        Number number = (Number) value;
        double numeric = number.doubleValue();
        if (!Double.isFinite(numeric) || numeric != Math.rint(numeric) || numeric < Integer.MIN_VALUE || numeric > Integer.MAX_VALUE) {
            throw typeMismatch(name + " must be an integer");
        }
        return (int) numeric;
    }

    private static KnoteException typeMismatch(String message) {
        return new KnoteException(ErrorCodes.TYPE_MISMATCH, message);
    }

    private boolean isLoaded(PluginCall call) {
        if (call == null) {
            return false;
        }
        if (grants == null || entries == null || saf == null || webSearch == null || searchExecutor == null) {
            call.reject("KnoteAndroid failed to initialize", ErrorCodes.IO_ERROR);
            return false;
        }
        return true;
    }

    private static void reject(PluginCall call, KnoteException exception) {
        if (call != null) {
            call.reject(exception.getMessage(), exception.getCode());
        }
    }

    private static void run(PluginCall call, JsOperation operation) {
        if (call == null) {
            return;
        }
        try {
            call.resolve(operation.run());
        } catch (KnoteException exception) {
            reject(call, exception);
        } catch (OutOfMemoryError error) {
            call.reject("Native operation exceeded memory limits", ErrorCodes.IO_ERROR);
        } catch (RuntimeException exception) {
            call.reject("Native operation failed", ErrorCodes.IO_ERROR);
        }
    }

    private static void runVoid(PluginCall call, VoidOperation operation) {
        if (call == null) {
            return;
        }
        try {
            operation.run();
            call.resolve();
        } catch (KnoteException exception) {
            reject(call, exception);
        } catch (OutOfMemoryError error) {
            call.reject("Native operation exceeded memory limits", ErrorCodes.IO_ERROR);
        } catch (RuntimeException exception) {
            call.reject("Native operation failed", ErrorCodes.IO_ERROR);
        }
    }

    private interface JsOperation {
        JSObject run() throws KnoteException;
    }

    private interface VoidOperation {
        void run() throws KnoteException;
    }
}
