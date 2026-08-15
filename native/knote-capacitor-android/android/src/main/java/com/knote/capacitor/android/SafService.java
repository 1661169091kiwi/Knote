package com.knote.capacitor.android;

import android.content.ContentResolver;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.net.Uri;
import android.os.Bundle;
import android.os.ParcelFileDescriptor;
import android.provider.DocumentsContract;
import android.util.Base64;
import androidx.documentfile.provider.DocumentFile;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import java.io.ByteArrayOutputStream;
import java.io.FileNotFoundException;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

final class SafService {
    private static final int MAX_LIST_ITEMS = 10_000;
    private static final int DELETE_MAX_DEPTH = 64;
    private static final int DELETE_MAX_ITEMS = 10_000;
    private static final int MAX_DOCUMENT_ID_LENGTH = 4096;
    private static final int MAX_URI_LENGTH = 16_384;
    private static final long MAX_MUTATION_DIGEST_BYTES = 512L * 1024L * 1024L;
    private static final long MAX_MUTATION_DIGEST_MILLIS = 30_000L;
    private static final long MAX_SAFE_JS_INTEGER = 9_007_199_254_740_991L;

    private final Context context;
    private final ContentResolver resolver;
    private final GrantStore grants;
    private final EntryStore entries;

    SafService(Context context, GrantStore grants, EntryStore entries) {
        if (context == null || grants == null || entries == null) {
            throw new IllegalArgumentException("Context, grant store, and entry store are required");
        }
        Context applicationContext = context.getApplicationContext();
        this.context = applicationContext == null ? context : applicationContext;
        resolver = this.context.getContentResolver();
        if (resolver == null) {
            throw new IllegalArgumentException("Content resolver is required");
        }
        this.grants = grants;
        this.entries = entries;
    }

    JSArray list(String grantId, String relativePath, String entryId) throws KnoteException {
        GrantStore.GrantAccess access = grants.require(grantId, true, false);
        PathPolicy.NormalizedPath path = normalizeForGrant(access, relativePath, true);
        Resolved resolved = resolveBound(access, path, entryId);
        DocumentMetadata parent = resolved.metadata;
        if (!parent.directory) {
            throw new KnoteException(ErrorCodes.TYPE_MISMATCH, "Path is not a directory");
        }

        grants.require(grantId, true, false);
        List<DocumentFile> children = listChildrenStrict(resolved.document, MAX_LIST_ITEMS);

        JSArray output = new JSArray();
        Set<String> returnedNames = new HashSet<>();
        for (DocumentFile child : children) {
            DocumentMetadata metadata = queryMetadata(child);
            String name;
            try {
                name = PathPolicy.normalizeName(metadata.rawName);
            } catch (KnoteException exception) {
                throw new KnoteException(ErrorCodes.IO_ERROR, "Provider returned an unrepresentable document name");
            }
            if (!returnedNames.add(name)) {
                throw new KnoteException(ErrorCodes.IO_ERROR, "Provider returned ambiguous document names");
            }
            String childPath = joinPath(path.value, name);
            output.put(toJsMetadata(access, child, metadata, childPath));
        }
        requireUnchanged(access, resolved);
        return output;
    }

    JSObject stat(String grantId, String relativePath, String entryId, String parentEntryId) throws KnoteException {
        GrantStore.GrantAccess access = grants.require(grantId, true, false);
        PathPolicy.NormalizedPath path = normalizeForGrant(access, relativePath, true);
        Resolved resolved = lookupBound(access, path, entryId, parentEntryId);
        grants.require(grantId, true, false);
        resolved = requireUnchanged(access, resolved);
        return toJsMetadata(access, resolved.document, resolved.metadata, path.value);
    }

    JSObject readFile(String grantId, String relativePath, String entryId) throws KnoteException {
        GrantStore.GrantAccess access = grants.require(grantId, true, false);
        PathPolicy.NormalizedPath path = normalizeForGrant(access, relativePath, true);
        Resolved resolved = resolveBound(access, path, entryId);
        grants.require(grantId, true, false);
        resolved = requireUnchanged(access, resolved);
        DocumentMetadata metadata = resolved.metadata;
        if (metadata.directory) {
            throw new KnoteException(ErrorCodes.TYPE_MISMATCH, "Path is not a file");
        }
        if (supports(metadata.flags, DocumentsContract.Document.FLAG_VIRTUAL_DOCUMENT)) {
            throw new KnoteException(ErrorCodes.UNSUPPORTED_OPERATION, "Virtual documents are not readable as files");
        }
        if (metadata.size > Base64Policy.MAX_BYTES) {
            throw new KnoteException(ErrorCodes.IO_ERROR, "File exceeds read limit");
        }
        if (!metadata.readable) {
            throw new KnoteException(ErrorCodes.GRANT_REVOKED, "File is not readable");
        }

        byte[] bytes;
        try {
            ParcelFileDescriptor descriptor = resolver.openFileDescriptor(resolved.document.getUri(), "r");
            if (descriptor == null) {
                throw new FileNotFoundException();
            }
            long descriptorSize = descriptor.getStatSize();
            try (InputStream input = new ParcelFileDescriptor.AutoCloseInputStream(descriptor);
                ByteArrayOutputStream output = new ByteArrayOutputStream(metadata.size > 0 ? (int) metadata.size : 8192)) {
                if (descriptorSize > Base64Policy.MAX_BYTES) {
                    throw new KnoteException(ErrorCodes.IO_ERROR, "File exceeds read limit");
                }
                byte[] buffer = new byte[8192];
                int total = 0;
                int count;
                while ((count = input.read(buffer)) != -1) {
                    if (count == 0) {
                        continue;
                    }
                    if (count > Base64Policy.MAX_BYTES - total) {
                        throw new KnoteException(ErrorCodes.IO_ERROR, "File exceeds read limit");
                    }
                    total += count;
                    output.write(buffer, 0, count);
                }
                bytes = output.toByteArray();
            }
        } catch (OutOfMemoryError error) {
            throw new KnoteException(ErrorCodes.IO_ERROR, "File could not be buffered within memory limits");
        } catch (KnoteException exception) {
            throw exception;
        } catch (SecurityException exception) {
            throw revoked();
        } catch (IllegalArgumentException exception) {
            throw ioError();
        } catch (FileNotFoundException exception) {
            throw new KnoteException(ErrorCodes.NOT_FOUND, "File was not found");
        } catch (IOException exception) {
            throw ioError();
        }

        resolved = requireUnchanged(access, resolved);
        return new JSObject()
            .put("data", encodeBase64(bytes))
            .put("metadata", toJsMetadata(access, resolved.document, resolved.metadata, path.value));
    }

    JSObject writeFile(String grantId, String relativePath, String entryId, String encodedData) throws KnoteException {
        GrantStore.GrantAccess access = grants.require(grantId, true, true);
        PathPolicy.NormalizedPath path = normalizeForGrant(access, relativePath, true);
        int expectedLength = Base64Policy.validateAndGetDecodedLength(encodedData);
        Resolved resolved = resolveBound(access, path, entryId);
        DocumentMetadata metadata = resolved.metadata;
        if (metadata.directory) {
            throw new KnoteException(ErrorCodes.TYPE_MISMATCH, "Path is not a file");
        }
        if (supports(metadata.flags, DocumentsContract.Document.FLAG_VIRTUAL_DOCUMENT)) {
            throw new KnoteException(ErrorCodes.UNSUPPORTED_OPERATION, "Virtual documents are not writable as files");
        }
        if (!supports(metadata.flags, DocumentsContract.Document.FLAG_SUPPORTS_WRITE)) {
            throw new KnoteException(ErrorCodes.UNSUPPORTED_OPERATION, "File does not support content writes");
        }
        if (!metadata.writable) {
            throw new KnoteException(ErrorCodes.READ_ONLY, "File is read-only");
        }

        byte[] data;
        try {
            data = Base64.decode(encodedData, Base64.NO_WRAP);
        } catch (OutOfMemoryError error) {
            throw new KnoteException(ErrorCodes.IO_ERROR, "Base64 data could not be decoded within memory limits");
        } catch (IllegalArgumentException exception) {
            throw new KnoteException(ErrorCodes.TYPE_MISMATCH, "Invalid base64 data");
        }
        if (data.length != expectedLength || data.length > Base64Policy.MAX_BYTES) {
            throw new KnoteException(ErrorCodes.TYPE_MISMATCH, "Base64 data exceeds write limit");
        }
        grants.require(grantId, true, true);
        resolved = requireUnchanged(access, resolved);

        boolean writeMayHaveOccurred = false;
        try {
            writeMayHaveOccurred = true;
            ParcelFileDescriptor descriptor = resolver.openFileDescriptor(resolved.document.getUri(), "wt");
            if (descriptor == null) {
                throw new FileNotFoundException();
            }
            long descriptorSize = descriptor.getStatSize();
            try (FileOutputStream output = new ParcelFileDescriptor.AutoCloseOutputStream(descriptor)) {
                output.write(data);
                output.flush();
                try {
                    descriptor.getFileDescriptor().sync();
                } catch (java.io.SyncFailedException exception) {
                    if (descriptorSize >= 0) {
                        throw exception;
                    }
                }
            }
        } catch (OutOfMemoryError error) {
            throw writeMayHaveOccurred
                ? writeUncertain()
                : new KnoteException(ErrorCodes.IO_ERROR, "Write exceeded memory limits");
        } catch (SecurityException exception) {
            throw writeMayHaveOccurred ? writeUncertain() : revokedOrReadOnly(access);
        } catch (FileNotFoundException exception) {
            throw writeMayHaveOccurred
                ? writeUncertain()
                : new KnoteException(ErrorCodes.UNSUPPORTED_OPERATION, "Provider cannot open the file for truncating write");
        } catch (IllegalArgumentException exception) {
            if (writeMayHaveOccurred) {
                throw writeUncertain();
            }
            throw new KnoteException(ErrorCodes.UNSUPPORTED_OPERATION, "Provider cannot open the file for truncating write");
        } catch (IOException exception) {
            throw writeMayHaveOccurred ? writeUncertain() : ioError();
        } catch (RuntimeException exception) {
            throw writeMayHaveOccurred ? writeUncertain() : ioError();
        }

        try {
            Resolved written = requireSameIdentity(access, path, resolved);
            verifyWrittenBytes(written.document.getUri(), data);
            grants.require(grantId, true, true);
            written = requireSameIdentity(access, path, written);
            updateEntryCapability(access, entryId, written.document, path.value, written.metadata);
            return toJsMetadata(access, written.document, written.metadata, path.value);
        } catch (OutOfMemoryError | RuntimeException | KnoteException exception) {
            throw writeUncertain();
        }
    }

    JSObject createFile(String grantId, String relativePath, String parentEntryId, String mimeType) throws KnoteException {
        GrantStore.GrantAccess access = grants.require(grantId, true, true);
        requireTree(access);
        PathPolicy.NormalizedPath path = normalizeForGrant(access, relativePath, false);
        String safeMimeType = MimePolicy.validate(mimeType == null ? "application/octet-stream" : mimeType, false);
        return create(access, path, parentEntryId, safeMimeType);
    }

    JSObject createDirectory(String grantId, String relativePath, String parentEntryId) throws KnoteException {
        GrantStore.GrantAccess access = grants.require(grantId, true, true);
        requireTree(access);
        PathPolicy.NormalizedPath path = normalizeForGrant(access, relativePath, false);
        return create(access, path, parentEntryId, DocumentsContract.Document.MIME_TYPE_DIR);
    }

    JSObject rename(String grantId, String relativePath, String entryId, String newName) throws KnoteException {
        GrantStore.GrantAccess access = grants.require(grantId, true, true);
        String safeName = PathPolicy.requireCanonicalName(newName);
        requireTree(access);
        PathPolicy.NormalizedPath path = normalizeForGrant(access, relativePath, false);
        ParentAndName source = resolveParent(access, path);
        DocumentFile document = findChild(source.parent, source.name);
        if (document == null) {
            throw new KnoteException(ErrorCodes.NOT_FOUND, "Path was not found");
        }
        DocumentMetadata metadata = queryMetadata(document);
        requireEntryCapability(access, entryId, document, path.value, metadata);
        if (safeName.equals(source.name)) {
            if (safeName.equals(metadata.rawName)) {
                return toJsMetadata(access, document, metadata, path.value);
            }
            throw new KnoteException(ErrorCodes.TARGET_EXISTS, "Normalized name already identifies this document");
        }
        if (findChild(source.parent, safeName) != null) {
            throw new KnoteException(ErrorCodes.TARGET_EXISTS, "A destination with that name already exists");
        }

        if (!supports(metadata.flags, DocumentsContract.Document.FLAG_SUPPORTS_RENAME)) {
            throw new KnoteException(ErrorCodes.UNSUPPORTED_OPERATION, "Provider does not support rename");
        }
        if (!metadata.writable) {
            throw new KnoteException(ErrorCodes.READ_ONLY, "Document is read-only");
        }
        byte[] sourceDigest = mutationDigest(document, metadata);
        grants.require(grantId, true, true);
        Resolved renameReady = requireUnchanged(access, new Resolved(document, path, metadata));
        metadata = renameReady.metadata;
        if (!supports(metadata.flags, DocumentsContract.Document.FLAG_SUPPORTS_RENAME)) {
            throw new KnoteException(ErrorCodes.UNSUPPORTED_OPERATION, "Provider no longer supports rename");
        }
        if (!metadata.writable) {
            throw new KnoteException(ErrorCodes.READ_ONLY, "Document is no longer writable");
        }
        source = resolveParent(access, path);
        document = findChild(source.parent, source.name);
        if (document == null || !document.getUri().equals(renameReady.document.getUri())) {
            throw entryChanged();
        }
        Uri renamedUri;
        try {
            renamedUri = DocumentsContract.renameDocument(resolver, document.getUri(), safeName);
        } catch (SecurityException exception) {
            throw mutationUncertain("rename");
        } catch (FileNotFoundException exception) {
            throw mutationUncertain("rename");
        } catch (IllegalArgumentException | UnsupportedOperationException exception) {
            throw mutationUncertain("rename");
        } catch (RuntimeException exception) {
            throw mutationUncertain("rename");
        }
        if (renamedUri == null) {
            throw mutationUncertain("rename");
        }
        try {
            if (!document.getUri().getAuthority().equals(renamedUri.getAuthority())) {
                throw mutationUncertain("rename");
            }
            String destination = joinPath(parentPath(path), safeName);
            PathPolicy.NormalizedPath destinationPath = PathPolicy.normalize(destination, false);
            Resolved renamed = resolve(access, destinationPath);
            document = renamed.document;
            DocumentMetadata renamedMetadata = renamed.metadata;
            if (
                !document.getUri().equals(renamedUri) ||
                renamedMetadata.directory != metadata.directory ||
                (metadata.size >= 0 && renamedMetadata.size >= 0 && metadata.size != renamedMetadata.size) ||
                (sourceDigest != null && !MessageDigest.isEqual(sourceDigest, mutationDigest(document, renamedMetadata)))
            ) {
                throw mutationUncertain("rename");
            }
            String actualName = PathPolicy.normalizeName(renamedMetadata.rawName);
            if (!safeName.equals(actualName)) {
                throw mutationUncertain("rename");
            }
            ParentAndName verifiedParent = resolveParent(access, destinationPath);
            DocumentFile verified = findChild(verifiedParent.parent, safeName);
            if (verified == null || !verified.getUri().equals(renamedUri)) {
                throw mutationUncertain("rename");
            }
            try {
                resolve(access, path);
                throw mutationUncertain("rename");
            } catch (KnoteException exception) {
                if (!ErrorCodes.NOT_FOUND.equals(exception.getCode())) {
                    throw exception;
                }
            }
            updateEntryCapability(access, entryId, document, destination, renamedMetadata);
            refreshEntryBinding(access, verifiedParent.parent, parentPath(path));
            return toJsMetadata(access, document, renamedMetadata, destination);
        } catch (KnoteException exception) {
            throw mutationUncertain("rename");
        } catch (OutOfMemoryError | RuntimeException exception) {
            throw mutationUncertain("rename");
        }
    }

    JSObject move(
        String grantId,
        String relativePath,
        String destinationPath,
        String entryId,
        String destinationEntryId
    ) throws KnoteException {
        GrantStore.GrantAccess access = grants.require(grantId, true, true);
        requireTree(access);
        PathPolicy.NormalizedPath sourcePath = normalizeForGrant(access, relativePath, false);
        PathPolicy.NormalizedPath targetPath = normalizeForGrant(access, destinationPath, true);
        if (targetPath.value.equals(sourcePath.value) || targetPath.value.startsWith(sourcePath.value + "/")) {
            throw new KnoteException(ErrorCodes.BAD_PATH, "A document cannot be moved into itself");
        }

        ParentAndName source = resolveParent(access, sourcePath);
        DocumentFile document = findChild(source.parent, source.name);
        if (document == null) {
            throw new KnoteException(ErrorCodes.NOT_FOUND, "Path was not found");
        }
        DocumentMetadata sourceMetadata = queryMetadata(document);
        requireEntryCapability(access, entryId, document, sourcePath.value, sourceMetadata);
        Resolved destination = resolveBound(access, targetPath, destinationEntryId);
        DocumentMetadata destinationMetadata = queryMetadata(destination.document);
        if (!destinationMetadata.directory) {
            throw new KnoteException(ErrorCodes.TYPE_MISMATCH, "Destination is not a directory");
        }
        if (document.getUri().equals(destination.document.getUri())) {
            throw new KnoteException(ErrorCodes.BAD_PATH, "A document cannot be moved into itself");
        }
        if (source.parent.getUri().equals(destination.document.getUri())) {
            return toJsMetadata(access, document, sourceMetadata, sourcePath.value);
        }
        if (findChild(destination.document, source.name) != null) {
            throw new KnoteException(ErrorCodes.TARGET_EXISTS, "Destination already contains that name");
        }

        if (!supports(sourceMetadata.flags, DocumentsContract.Document.FLAG_SUPPORTS_MOVE)) {
            throw new KnoteException(ErrorCodes.UNSUPPORTED_OPERATION, "Provider does not support move");
        }
        if (!sourceMetadata.writable || !destinationMetadata.writable) {
            throw new KnoteException(ErrorCodes.READ_ONLY, "Source or destination is read-only");
        }
        byte[] sourceDigest = mutationDigest(document, sourceMetadata);
        grants.require(grantId, true, true);
        Resolved moveReady = requireUnchanged(access, new Resolved(document, sourcePath, sourceMetadata));
        source = resolveParent(access, sourcePath);
        document = findChild(source.parent, source.name);
        destination = resolveBound(access, targetPath, destinationEntryId);
        sourceMetadata = moveReady.metadata;
        destinationMetadata = destination.metadata;
        if (
            document == null ||
            !document.getUri().equals(moveReady.document.getUri()) ||
            !destinationMetadata.directory
        ) {
            throw entryChanged();
        }
        if (!supports(sourceMetadata.flags, DocumentsContract.Document.FLAG_SUPPORTS_MOVE)) {
            throw new KnoteException(ErrorCodes.UNSUPPORTED_OPERATION, "Provider no longer supports move");
        }
        if (!sourceMetadata.writable || !destinationMetadata.writable) {
            throw new KnoteException(ErrorCodes.READ_ONLY, "Source or destination is no longer writable");
        }

        Uri movedUri;
        try {
            movedUri = DocumentsContract.moveDocument(
                resolver,
                document.getUri(),
                source.parent.getUri(),
                destination.document.getUri()
            );
        } catch (SecurityException exception) {
            throw mutationUncertain("move");
        } catch (FileNotFoundException exception) {
            throw mutationUncertain("move");
        } catch (IllegalArgumentException | UnsupportedOperationException exception) {
            throw mutationUncertain("move");
        } catch (RuntimeException exception) {
            throw mutationUncertain("move");
        }
        if (movedUri == null) {
            throw mutationUncertain("move");
        }
        try {
            if (!document.getUri().getAuthority().equals(movedUri.getAuthority())) {
                throw mutationUncertain("move");
            }
            String movedPath = joinPath(targetPath.value, source.name);
            PathPolicy.NormalizedPath normalizedMovedPath = PathPolicy.normalize(movedPath, false);
            Resolved movedResolved = resolve(access, normalizedMovedPath);
            DocumentFile moved = movedResolved.document;
            DocumentMetadata movedMetadata = movedResolved.metadata;
            if (
                !moved.getUri().equals(movedUri) ||
                movedMetadata.directory != sourceMetadata.directory ||
                !sameMimeType(sourceMetadata.mimeType, movedMetadata.mimeType) ||
                (sourceMetadata.size >= 0 && movedMetadata.size >= 0 && sourceMetadata.size != movedMetadata.size) ||
                (sourceDigest != null && !MessageDigest.isEqual(sourceDigest, mutationDigest(moved, movedMetadata)))
            ) {
                throw mutationUncertain("move");
            }
            String movedName = PathPolicy.normalizeName(movedMetadata.rawName);
            if (!source.name.equals(movedName)) {
                throw mutationUncertain("move");
            }
            Resolved verifiedDestination = resolve(access, targetPath);
            DocumentFile verified = findChild(verifiedDestination.document, source.name);
            if (verified == null || !verified.getUri().equals(movedUri)) {
                throw mutationUncertain("move");
            }
            try {
                resolve(access, sourcePath);
                throw mutationUncertain("move");
            } catch (KnoteException exception) {
                if (!ErrorCodes.NOT_FOUND.equals(exception.getCode())) {
                    throw exception;
                }
            }
            updateEntryCapability(access, entryId, moved, movedPath, movedMetadata);
            Resolved verifiedSourceParent = resolve(access, PathPolicy.normalize(parentPath(sourcePath), true));
            refreshEntryBinding(access, verifiedSourceParent.document, parentPath(sourcePath));
            refreshEntryBinding(access, verifiedDestination.document, targetPath.value);
            return toJsMetadata(access, moved, movedMetadata, movedPath);
        } catch (KnoteException exception) {
            throw mutationUncertain("move");
        } catch (OutOfMemoryError | RuntimeException exception) {
            throw mutationUncertain("move");
        }
    }

    void delete(String grantId, String relativePath, String entryId, boolean recursive) throws KnoteException {
        GrantStore.GrantAccess access = grants.require(grantId, true, true);
        PathPolicy.NormalizedPath path = normalizeForGrant(access, relativePath, true);
        if (access.record.kind.equals("tree") && path.value.isEmpty()) {
            throw new KnoteException(ErrorCodes.UNSUPPORTED_OPERATION, "The granted tree root cannot be deleted");
        }
        DocumentFile document;
        DocumentFile parent = null;
        String targetName = null;
        if (access.record.kind.equals("tree")) {
            ParentAndName target = resolveParent(access, path);
            parent = target.parent;
            targetName = target.name;
            document = findChild(parent, target.name);
            if (document == null) {
                throw new KnoteException(ErrorCodes.NOT_FOUND, "Path was not found");
            }
        } else {
            document = resolve(access, path).document;
        }
        DocumentMetadata metadata = queryMetadata(document);
        if (access.record.kind.equals("tree")) {
            requireEntryCapability(access, entryId, document, path.value, metadata);
        } else if (entryId != null && !entryId.isEmpty()) {
            throw new KnoteException(ErrorCodes.BAD_GRANT, "Standalone document roots do not accept entry capabilities");
        }
        boolean canRemove = access.record.kind.equals("tree") &&
            supports(metadata.flags, DocumentsContract.Document.FLAG_SUPPORTS_REMOVE);
        boolean canDelete = supports(metadata.flags, DocumentsContract.Document.FLAG_SUPPORTS_DELETE);
        if (!canRemove && !canDelete) {
            throw new KnoteException(
                ErrorCodes.UNSUPPORTED_OPERATION,
                "Provider does not support deleting this document"
            );
        }
        if (!metadata.writable) {
            throw new KnoteException(ErrorCodes.READ_ONLY, "Document is read-only");
        }
        if (metadata.directory) {
            if (!recursive) {
                throw new KnoteException(ErrorCodes.UNSUPPORTED_OPERATION, "recursive is required for directory deletion");
            }
            preflightRecursiveDelete(document);
        }
        grants.require(grantId, true, true);
        Resolved deleteReady = requireUnchanged(access, new Resolved(document, path, metadata));
        document = deleteReady.document;
        metadata = deleteReady.metadata;
        canRemove = access.record.kind.equals("tree") &&
            supports(metadata.flags, DocumentsContract.Document.FLAG_SUPPORTS_REMOVE);
        canDelete = supports(metadata.flags, DocumentsContract.Document.FLAG_SUPPORTS_DELETE);
        if (!canRemove && !canDelete) {
            throw new KnoteException(ErrorCodes.UNSUPPORTED_OPERATION, "Provider no longer supports deleting this document");
        }
        if (!metadata.writable) {
            throw new KnoteException(ErrorCodes.READ_ONLY, "Document is no longer writable");
        }
        if (access.record.kind.equals("tree")) {
            ParentAndName currentTarget = resolveParent(access, path);
            DocumentFile currentDocument = findChild(currentTarget.parent, currentTarget.name);
            if (currentDocument == null || !currentDocument.getUri().equals(document.getUri())) {
                throw entryChanged();
            }
            parent = currentTarget.parent;
            targetName = currentTarget.name;
        }
        boolean deleted;
        try {
            deleted = canRemove
                ? DocumentsContract.removeDocument(resolver, document.getUri(), parent.getUri())
                : DocumentsContract.deleteDocument(resolver, document.getUri());
        } catch (SecurityException exception) {
            throw mutationUncertain("delete");
        } catch (FileNotFoundException exception) {
            throw mutationUncertain("delete");
        } catch (IllegalArgumentException | UnsupportedOperationException exception) {
            throw mutationUncertain("delete");
        } catch (RuntimeException exception) {
            throw mutationUncertain("delete");
        }
        if (!deleted) {
            throw mutationUncertain("delete");
        }
        if (access.record.kind.equals("tree")) {
            try {
                try {
                    resolve(access, path);
                    throw mutationUncertain("delete");
                } catch (KnoteException exception) {
                    if (!ErrorCodes.NOT_FOUND.equals(exception.getCode())) {
                        throw exception;
                    }
                }
            } catch (KnoteException exception) {
                throw mutationUncertain("delete");
            } catch (OutOfMemoryError | RuntimeException exception) {
                throw mutationUncertain("delete");
            }
            try {
                entries.forgetPath(access.record.grantId, path.value, metadata.directory);
                Resolved currentParent = resolve(access, PathPolicy.normalize(parentPath(path), true));
                refreshEntryBinding(access, currentParent.document, parentPath(path));
            } catch (KnoteException exception) {
                throw mutationUncertain("delete");
            }
        } else {
            boolean stillExists = true;
            try {
                queryMetadata(document);
            } catch (KnoteException exception) {
                if (
                    ErrorCodes.NOT_FOUND.equals(exception.getCode()) ||
                    ErrorCodes.GRANT_REVOKED.equals(exception.getCode())
                ) {
                    stillExists = false;
                } else {
                    throw mutationUncertain("delete");
                }
            } catch (OutOfMemoryError | RuntimeException exception) {
                throw mutationUncertain("delete");
            }
            if (stillExists) {
                throw mutationUncertain("delete");
            }
            try {
                grants.forgetDeletedDocument(access);
            } catch (KnoteException exception) {
                throw mutationUncertain("delete");
            }
        }
    }

    private JSObject create(
        GrantStore.GrantAccess access,
        PathPolicy.NormalizedPath path,
        String parentEntryId,
        String mimeType
    ) throws KnoteException {
        requireTree(access);
        ParentAndName target = resolveParentBound(access, path, parentEntryId);
        if (findChild(target.parent, target.name) != null) {
            throw new KnoteException(ErrorCodes.TARGET_EXISTS, "Target already exists");
        }

        DocumentMetadata parentMetadata = queryMetadata(target.parent);
        if (!parentMetadata.directory) {
            throw new KnoteException(ErrorCodes.TYPE_MISMATCH, "Parent path is not a directory");
        }
        if (!supports(parentMetadata.flags, DocumentsContract.Document.FLAG_DIR_SUPPORTS_CREATE)) {
            throw new KnoteException(ErrorCodes.UNSUPPORTED_OPERATION, "Provider does not support creation here");
        }
        if (!parentMetadata.writable) {
            throw new KnoteException(ErrorCodes.READ_ONLY, "Parent directory is read-only");
        }
        grants.require(access.record.grantId, true, true);
        PathPolicy.NormalizedPath parentPath = PathPolicy.normalize(parentPath(path), true);
        Resolved expectedParent = new Resolved(target.parent, parentPath, parentMetadata);
        Resolved currentParent = requireUnchanged(access, expectedParent);
        if (
            !supports(currentParent.metadata.flags, DocumentsContract.Document.FLAG_DIR_SUPPORTS_CREATE) ||
            !currentParent.metadata.writable
        ) {
            throw new KnoteException(ErrorCodes.READ_ONLY, "Parent directory is no longer writable");
        }
        target = resolveParentBound(access, path, parentEntryId);
        if (!target.parent.getUri().equals(currentParent.document.getUri())) {
            throw entryChanged();
        }
        if (findChild(target.parent, target.name) != null) {
            throw new KnoteException(ErrorCodes.TARGET_EXISTS, "Target already exists");
        }

        Uri createdUri;
        try {
            createdUri = DocumentsContract.createDocument(resolver, target.parent.getUri(), mimeType, target.name);
        } catch (SecurityException exception) {
            throw mutationUncertain("create");
        } catch (FileNotFoundException exception) {
            throw mutationUncertain("create");
        } catch (IllegalArgumentException | UnsupportedOperationException exception) {
            throw mutationUncertain("create");
        } catch (RuntimeException exception) {
            throw mutationUncertain("create");
        }
        if (createdUri == null) {
            throw mutationUncertain("create");
        }
        try {
            if (!target.parent.getUri().getAuthority().equals(createdUri.getAuthority())) {
                throw mutationUncertain("create");
            }
            Resolved createdResolved = resolve(access, path);
            DocumentFile created = createdResolved.document;
            DocumentMetadata metadata = createdResolved.metadata;
            boolean expectedDirectory = DocumentsContract.Document.MIME_TYPE_DIR.equals(mimeType);
            if (
                !created.getUri().equals(createdUri) ||
                metadata.directory != expectedDirectory ||
                !sameMimeType(mimeType, metadata.mimeType)
            ) {
                throw mutationUncertain("create");
            }
            String actualName = PathPolicy.normalizeName(metadata.rawName);
            if (!target.name.equals(actualName)) {
                throw mutationUncertain("create");
            }
            ParentAndName verifiedParent = resolveParent(access, path);
            DocumentFile verified = findChild(verifiedParent.parent, target.name);
            if (verified == null || !verified.getUri().equals(createdUri)) {
                throw mutationUncertain("create");
            }
            refreshEntryBinding(access, verifiedParent.parent, parentPath(path));
            return toJsMetadata(access, created, metadata, path.value);
        } catch (KnoteException exception) {
            throw mutationUncertain("create");
        } catch (OutOfMemoryError | RuntimeException exception) {
            throw mutationUncertain("create");
        }
    }

    private Resolved resolve(GrantStore.GrantAccess access, PathPolicy.NormalizedPath path) throws KnoteException {
        if (access.record.kind.equals("document")) {
            if (!path.value.isEmpty()) {
                throw new KnoteException(ErrorCodes.BAD_PATH, "Standalone document paths must be empty");
            }
            return new Resolved(access.root, path, queryMetadata(access.root));
        }

        DocumentFile current = access.root;
        for (String segment : path.segments) {
            DocumentMetadata currentMetadata = queryMetadata(current);
            if (!currentMetadata.directory) {
                throw new KnoteException(ErrorCodes.TYPE_MISMATCH, "A path component is not a directory");
            }
            current = findChild(current, segment);
            if (current == null) {
                throw new KnoteException(ErrorCodes.NOT_FOUND, "Path was not found");
            }
        }
        return new Resolved(current, path, queryMetadata(current));
    }

    private Resolved resolveBound(
        GrantStore.GrantAccess access,
        PathPolicy.NormalizedPath path,
        String entryId
    ) throws KnoteException {
        Resolved resolved = resolve(access, path);
        if (access.record.kind.equals("tree") && !path.value.isEmpty()) {
            requireEntryCapability(access, entryId, resolved.document, path.value, resolved.metadata);
        } else if (entryId != null && !entryId.isEmpty()) {
            throw new KnoteException(ErrorCodes.BAD_GRANT, "Grant roots do not accept entry capabilities");
        }
        return resolved;
    }

    private Resolved lookupBound(
        GrantStore.GrantAccess access,
        PathPolicy.NormalizedPath path,
        String entryId,
        String parentEntryId
    ) throws KnoteException {
        if (path.value.isEmpty() || (entryId != null && !entryId.isEmpty())) {
            return resolveBound(access, path, entryId);
        }
        requireTree(access);
        ParentAndName target = resolveParentBound(access, path, parentEntryId);
        DocumentFile document = findChild(target.parent, target.name);
        if (document == null) {
            throw new KnoteException(ErrorCodes.NOT_FOUND, "Path was not found");
        }
        return new Resolved(document, path, queryMetadata(document));
    }

    private ParentAndName resolveParent(GrantStore.GrantAccess access, PathPolicy.NormalizedPath path) throws KnoteException {
        if (path.segments.isEmpty()) {
            throw new KnoteException(ErrorCodes.BAD_PATH, "Path must name a child of the tree");
        }
        List<String> parentSegments = path.segments.subList(0, path.segments.size() - 1);
        PathPolicy.NormalizedPath parentPath = new PathPolicy.NormalizedPath(
            PathPolicy.join(parentSegments),
            parentSegments
        );
        Resolved parent = resolve(access, parentPath);
        DocumentMetadata parentMetadata = parent.metadata;
        if (!parentMetadata.directory) {
            throw new KnoteException(ErrorCodes.TYPE_MISMATCH, "Parent path is not a directory");
        }
        return new ParentAndName(parent.document, path.segments.get(path.segments.size() - 1));
    }

    private ParentAndName resolveParentBound(
        GrantStore.GrantAccess access,
        PathPolicy.NormalizedPath path,
        String parentEntryId
    ) throws KnoteException {
        if (path.segments.isEmpty()) {
            throw new KnoteException(ErrorCodes.BAD_PATH, "Path must name a child of the tree");
        }
        List<String> parentSegments = path.segments.subList(0, path.segments.size() - 1);
        PathPolicy.NormalizedPath parentPath = new PathPolicy.NormalizedPath(
            PathPolicy.join(parentSegments),
            parentSegments
        );
        Resolved parent = resolveBound(access, parentPath, parentEntryId);
        DocumentMetadata parentMetadata = parent.metadata;
        if (!parentMetadata.directory) {
            throw new KnoteException(ErrorCodes.TYPE_MISMATCH, "Parent path is not a directory");
        }
        return new ParentAndName(parent.document, path.segments.get(path.segments.size() - 1));
    }

    private DocumentFile findChild(DocumentFile directory, String name) throws KnoteException {
        DocumentFile match = null;
        for (DocumentFile child : listChildrenStrict(directory, MAX_LIST_ITEMS)) {
            DocumentMetadata metadata = queryMetadata(child);
            String normalizedName;
            try {
                normalizedName = PathPolicy.normalizeName(metadata.rawName);
            } catch (KnoteException exception) {
                throw new KnoteException(ErrorCodes.IO_ERROR, "Provider returned an unrepresentable document name");
            }
            if (!name.equals(normalizedName)) {
                continue;
            }
            if (match != null) {
                throw new KnoteException(ErrorCodes.IO_ERROR, "Provider returned duplicate document names");
            }
            match = child;
        }
        return match;
    }

    private List<DocumentFile> listChildrenStrict(DocumentFile directory, int maxItems) throws KnoteException {
        if (maxItems < 0) {
            throw new KnoteException(ErrorCodes.IO_ERROR, "Directory exceeds item limit");
        }
        DocumentMetadata directoryMetadata = queryMetadata(directory);
        if (!directoryMetadata.directory) {
            throw new KnoteException(ErrorCodes.TYPE_MISMATCH, "Path is not a directory");
        }
        if (!directoryMetadata.readable) {
            throw revoked();
        }
        Uri childrenUri;
        String parentDocumentId;
        try {
            parentDocumentId = DocumentsContract.getDocumentId(directory.getUri());
            if (parentDocumentId == null || parentDocumentId.isEmpty()) {
                throw new IllegalArgumentException("Document identifier is missing");
            }
            if (parentDocumentId.length() > MAX_DOCUMENT_ID_LENGTH) {
                throw new IllegalArgumentException("Document identifier exceeds limit");
            }
            childrenUri = DocumentsContract.buildChildDocumentsUriUsingTree(
                directory.getUri(),
                parentDocumentId
            );
        } catch (IllegalArgumentException exception) {
            throw new KnoteException(ErrorCodes.UNSUPPORTED_OPERATION, "Provider does not expose tree children");
        }

        List<DocumentFile> children = new ArrayList<>();
        String[] projection = { DocumentsContract.Document.COLUMN_DOCUMENT_ID };
        try (Cursor cursor = resolver.query(childrenUri, projection, null, null, null)) {
            if (cursor == null) {
                throw ioError();
            }
            checkCursorExtras(cursor.getExtras());
            int idColumn = cursor.getColumnIndex(DocumentsContract.Document.COLUMN_DOCUMENT_ID);
            if (idColumn < 0) {
                throw ioError();
            }
            int count = cursor.getCount();
            if (count < 0 || count > maxItems) {
                throw new KnoteException(ErrorCodes.IO_ERROR, "Directory exceeds item limit");
            }
            Set<String> documentIds = new HashSet<>();
            while (cursor.moveToNext()) {
                if (cursor.isNull(idColumn)) {
                    throw new KnoteException(ErrorCodes.IO_ERROR, "Directory exceeds item limit or returned invalid data");
                }
                String documentId = cursor.getString(idColumn);
                if (documentId == null || documentId.isEmpty() || documentId.length() > MAX_DOCUMENT_ID_LENGTH) {
                    throw new KnoteException(ErrorCodes.IO_ERROR, "Provider returned an invalid document identifier");
                }
                if (documentId.equals(parentDocumentId)) {
                    throw new KnoteException(ErrorCodes.IO_ERROR, "Provider returned the directory as its own child");
                }
                if (!documentIds.add(documentId)) {
                    throw new KnoteException(ErrorCodes.IO_ERROR, "Provider returned a duplicate document identifier");
                }
                Uri childUri = DocumentsContract.buildDocumentUriUsingTree(directory.getUri(), documentId);
                if (!directory.getUri().getAuthority().equals(childUri.getAuthority())) {
                    throw new KnoteException(ErrorCodes.IO_ERROR, "Provider returned a cross-authority child");
                }
                children.add(wrap(childUri));
                if (children.size() > maxItems) {
                    throw new KnoteException(ErrorCodes.IO_ERROR, "Directory exceeds item limit");
                }
            }
            checkCursorExtras(cursor.getExtras());
            return children;
        } catch (OutOfMemoryError error) {
            throw new KnoteException(ErrorCodes.IO_ERROR, "Directory listing exceeded memory limits");
        } catch (KnoteException exception) {
            throw exception;
        } catch (SecurityException exception) {
            throw revoked();
        } catch (IllegalArgumentException exception) {
            throw ioError();
        } catch (RuntimeException exception) {
            throw ioError();
        }
    }

    private static void checkCursorExtras(Bundle extras) throws KnoteException {
        if (extras == null) {
            return;
        }
        String error = extras.getString(DocumentsContract.EXTRA_ERROR);
        if (error != null && !error.isEmpty()) {
            throw new KnoteException(ErrorCodes.IO_ERROR, "Provider reported a directory listing error");
        }
        if (extras.getBoolean(DocumentsContract.EXTRA_LOADING, false)) {
            throw new KnoteException(ErrorCodes.IO_ERROR, "Provider directory listing is incomplete");
        }
    }

    private DocumentFile wrap(Uri uri) throws KnoteException {
        if (uri == null) {
            throw new KnoteException(ErrorCodes.IO_ERROR, "Provider returned no document URI");
        }
        String uriText;
        try {
            uriText = uri.toString();
        } catch (OutOfMemoryError error) {
            throw new KnoteException(ErrorCodes.IO_ERROR, "Document URI exceeded memory limits");
        } catch (RuntimeException exception) {
            throw new KnoteException(ErrorCodes.IO_ERROR, "Provider returned an invalid document URI");
        }
        if (uriText.length() > MAX_URI_LENGTH) {
            throw new KnoteException(ErrorCodes.IO_ERROR, "Provider returned an oversized document URI");
        }
        try {
            if (
                !DocumentsContract.isDocumentUri(context, uri) ||
                !DocumentsContract.isTreeUri(uri)
            ) {
                throw new KnoteException(ErrorCodes.IO_ERROR, "Provider returned an invalid document URI");
            }
        } catch (KnoteException exception) {
            throw exception;
        } catch (RuntimeException exception) {
            throw new KnoteException(ErrorCodes.IO_ERROR, "Provider returned an invalid document URI");
        }
        DocumentFile document;
        try {
            document = DocumentFile.fromSingleUri(context, uri);
        } catch (OutOfMemoryError error) {
            throw new KnoteException(ErrorCodes.IO_ERROR, "Document URI exceeded memory limits");
        } catch (RuntimeException exception) {
            throw new KnoteException(ErrorCodes.IO_ERROR, "Provider returned an invalid document URI");
        }
        if (document == null) {
            throw ioError();
        }
        return document;
    }

    private DocumentMetadata queryMetadata(DocumentFile document) throws KnoteException {
        if (document == null) {
            throw new KnoteException(ErrorCodes.IO_ERROR, "Provider returned no document");
        }
        Uri documentUri = document.getUri();
        if (documentUri == null) {
            throw new KnoteException(ErrorCodes.IO_ERROR, "Provider returned no document URI");
        }
        if (!"content".equals(documentUri.getScheme()) || documentUri.getAuthority() == null || documentUri.getAuthority().isEmpty()) {
            throw new KnoteException(ErrorCodes.IO_ERROR, "Provider returned an invalid document URI");
        }
        String documentUriText;
        try {
            documentUriText = documentUri.toString();
        } catch (OutOfMemoryError error) {
            throw new KnoteException(ErrorCodes.IO_ERROR, "Document URI exceeded memory limits");
        } catch (RuntimeException exception) {
            throw new KnoteException(ErrorCodes.IO_ERROR, "Provider returned an invalid document URI");
        }
        if (documentUriText.length() > MAX_URI_LENGTH) {
            throw new KnoteException(ErrorCodes.IO_ERROR, "Provider returned an oversized document URI");
        }
        String[] projection = {
            DocumentsContract.Document.COLUMN_DISPLAY_NAME,
            DocumentsContract.Document.COLUMN_MIME_TYPE,
            DocumentsContract.Document.COLUMN_SIZE,
            DocumentsContract.Document.COLUMN_LAST_MODIFIED,
            DocumentsContract.Document.COLUMN_FLAGS,
        };
        try (Cursor cursor = resolver.query(documentUri, projection, null, null, null)) {
            if (cursor == null) {
                throw new KnoteException(ErrorCodes.IO_ERROR, "Provider did not return document metadata");
            }
            int count = cursor.getCount();
            if (count == 0) {
                throw new KnoteException(ErrorCodes.NOT_FOUND, "Document was not found");
            }
            if (count != 1) {
                throw new KnoteException(ErrorCodes.IO_ERROR, "Provider returned ambiguous document metadata");
            }
            if (!cursor.moveToFirst()) {
                throw new KnoteException(ErrorCodes.IO_ERROR, "Provider returned inaccessible document metadata");
            }
            checkCursorExtras(cursor.getExtras());
            String rawName = cursor.isNull(0) ? "" : cursor.getString(0);
            String mimeType = cursor.isNull(1) ? null : cursor.getString(1);
            long size = cursor.isNull(2) ? -1 : cursor.getLong(2);
            long lastModified = cursor.isNull(3) ? -1 : cursor.getLong(3);
            long flags = cursor.isNull(4) ? 0 : cursor.getLong(4);
            checkCursorExtras(cursor.getExtras());
            if (rawName.length() > 4096 || (mimeType != null && mimeType.length() > 127)) {
                throw new KnoteException(ErrorCodes.IO_ERROR, "Provider returned oversized document metadata");
            }
            boolean directory = DocumentsContract.Document.MIME_TYPE_DIR.equals(mimeType);
            boolean hasReadPermission = hasUriPermission(document.getUri(), Intent.FLAG_GRANT_READ_URI_PERMISSION);
            boolean hasWritePermission = hasUriPermission(document.getUri(), Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
            boolean mutable = supports(flags, DocumentsContract.Document.FLAG_SUPPORTS_WRITE) ||
                supports(flags, DocumentsContract.Document.FLAG_SUPPORTS_DELETE) ||
                supports(flags, DocumentsContract.Document.FLAG_SUPPORTS_REMOVE) ||
                supports(flags, DocumentsContract.Document.FLAG_SUPPORTS_RENAME) ||
                supports(flags, DocumentsContract.Document.FLAG_SUPPORTS_MOVE) ||
                (directory && supports(flags, DocumentsContract.Document.FLAG_DIR_SUPPORTS_CREATE));
            return new DocumentMetadata(
                rawName,
                PathPolicy.safeDisplayName(rawName, directory ? "Folder" : "Document"),
                mimeType,
                size,
                lastModified,
                flags,
                directory,
                hasReadPermission && mimeType != null,
                hasWritePermission && mutable,
                hasWritePermission && !directory && supports(flags, DocumentsContract.Document.FLAG_SUPPORTS_WRITE)
            );
        } catch (KnoteException exception) {
            throw exception;
        } catch (SecurityException exception) {
            throw revoked();
        } catch (OutOfMemoryError error) {
            throw new KnoteException(ErrorCodes.IO_ERROR, "Document metadata exceeded memory limits");
        } catch (RuntimeException exception) {
            throw ioError();
        }
    }

    private boolean hasUriPermission(Uri uri, int flag) {
        try {
            return context.checkCallingOrSelfUriPermission(uri, flag) == PackageManager.PERMISSION_GRANTED;
        } catch (OutOfMemoryError error) {
            return false;
        } catch (RuntimeException exception) {
            return false;
        }
    }

    private Resolved requireUnchanged(GrantStore.GrantAccess access, Resolved expected) throws KnoteException {
        Resolved current;
        try {
            current = resolve(access, expected.path);
        } catch (KnoteException exception) {
            if (ErrorCodes.NOT_FOUND.equals(exception.getCode())) {
                throw entryChanged();
            }
            throw exception;
        }
        if (
            !current.document.getUri().equals(expected.document.getUri()) ||
            !sameMetadataSnapshot(expected.metadata, current.metadata)
        ) {
            throw entryChanged();
        }
        return current;
    }

    private Resolved requireSameIdentity(
        GrantStore.GrantAccess access,
        PathPolicy.NormalizedPath path,
        Resolved expected
    ) throws KnoteException {
        Resolved current;
        try {
            current = resolve(access, path);
        } catch (KnoteException exception) {
            throw writeUncertain();
        }
        if (
            !current.document.getUri().equals(expected.document.getUri()) ||
            current.metadata.directory != expected.metadata.directory ||
            !sameMimeType(current.metadata.mimeType, expected.metadata.mimeType) ||
            !sameCanonicalName(current.metadata.rawName, expected.metadata.rawName)
        ) {
            throw writeUncertain();
        }
        return current;
    }

    private static boolean sameMetadataSnapshot(DocumentMetadata left, DocumentMetadata right) {
        return left.directory == right.directory &&
            sameMimeType(left.mimeType, right.mimeType) &&
            left.size == right.size &&
            left.lastModified == right.lastModified &&
            left.rawName.equals(right.rawName);
    }

    private static boolean sameCanonicalName(String left, String right) {
        try {
            return PathPolicy.normalizeName(left).equals(PathPolicy.normalizeName(right));
        } catch (KnoteException exception) {
            return false;
        }
    }

    private void requireEntryCapability(
        GrantStore.GrantAccess access,
        String entryId,
        DocumentFile document,
        String relativePath,
        DocumentMetadata metadata
    ) throws KnoteException {
        if (!access.record.kind.equals("tree") || relativePath.isEmpty()) {
            if (entryId != null && !entryId.isEmpty()) {
                throw new KnoteException(ErrorCodes.BAD_GRANT, "Grant roots do not accept entry capabilities");
            }
            return;
        }
        entries.require(
            access.record.grantId,
            entryId,
            document.getUri().toString(),
            relativePath,
            metadata.directory,
            metadata.mimeType,
            metadata.size,
            metadata.lastModified
        );
    }

    private void updateEntryCapability(
        GrantStore.GrantAccess access,
        String entryId,
        DocumentFile document,
        String relativePath,
        DocumentMetadata metadata
    ) throws KnoteException {
        if (!access.record.kind.equals("tree") || relativePath.isEmpty()) {
            return;
        }
        entries.update(
            access.record.grantId,
            entryId,
            document.getUri().toString(),
            relativePath,
            metadata.directory,
            metadata.mimeType,
            metadata.size,
            metadata.lastModified
        );
    }

    private void refreshEntryBinding(
        GrantStore.GrantAccess access,
        DocumentFile document,
        String relativePath
    ) throws KnoteException {
        if (!access.record.kind.equals("tree") || relativePath.isEmpty()) {
            return;
        }
        DocumentMetadata metadata = queryMetadata(document);
        entries.refreshBinding(
            access.record.grantId,
            document.getUri().toString(),
            relativePath,
            metadata.directory,
            metadata.mimeType,
            metadata.size,
            metadata.lastModified
        );
    }

    private JSObject toJsMetadata(
        GrantStore.GrantAccess access,
        DocumentFile document,
        DocumentMetadata metadata,
        String relativePath
    ) throws KnoteException {
        if (relativePath == null) {
            relativePath = "";
        }
        String visibleName = metadata.name;
        int separator = relativePath.lastIndexOf('/');
        if (!relativePath.isEmpty()) {
            visibleName = relativePath.substring(separator + 1);
        }
        boolean readable = access.readable && metadata.readable;
        boolean writable = access.writable && metadata.writable;
        boolean contentWritable = access.writable && metadata.contentWritable;
        if (access.record.kind.equals("document") && relativePath.isEmpty()) {
            visibleName = access.record.displayName;
            readable = access.readable && metadata.mimeType != null;
            writable = access.writable && (
                supports(metadata.flags, DocumentsContract.Document.FLAG_SUPPORTS_WRITE) ||
                supports(metadata.flags, DocumentsContract.Document.FLAG_SUPPORTS_DELETE)
            );
            contentWritable = access.writable && metadata.contentWritable;
        }
        JSObject output = new JSObject()
            .put(
                "entryId",
                access.record.kind.equals("tree") && !relativePath.isEmpty()
                    ? entries.bind(
                        access.record.grantId,
                        document.getUri().toString(),
                        relativePath,
                        metadata.directory,
                        metadata.mimeType,
                        metadata.size,
                        metadata.lastModified
                    )
                    : ""
            )
            .put("name", visibleName)
            .put("relativePath", relativePath)
            .put("kind", metadata.directory ? "directory" : "file")
            .put("readable", readable)
            .put("writable", writable)
            .put("contentWritable", contentWritable);
        if (!metadata.directory && metadata.mimeType != null && !metadata.mimeType.isEmpty()) {
            output.put("mimeType", metadata.mimeType);
        }
        if (metadata.size >= 0 && metadata.size <= MAX_SAFE_JS_INTEGER) {
            output.put("size", metadata.size);
        }
        if (metadata.lastModified > 0 && metadata.lastModified <= MAX_SAFE_JS_INTEGER) {
            output.put("lastModified", metadata.lastModified);
        }
        return output;
    }

    private void preflightRecursiveDelete(DocumentFile root) throws KnoteException {
        ArrayDeque<DeleteNode> pending = new ArrayDeque<>();
        Set<String> visited = new HashSet<>();
        pending.push(new DeleteNode(root, 0));
        int items = 0;
        while (!pending.isEmpty()) {
            DeleteNode node = pending.pop();
            if (node.depth > DELETE_MAX_DEPTH || ++items > DELETE_MAX_ITEMS) {
                throw new KnoteException(ErrorCodes.UNSUPPORTED_OPERATION, "Directory exceeds recursive delete budget");
            }
            String identity = node.document.getUri().toString();
            if (identity.length() > MAX_URI_LENGTH) {
                throw new KnoteException(ErrorCodes.UNSUPPORTED_OPERATION, "Provider returned an oversized document URI");
            }
            if (!visited.add(identity)) {
                throw new KnoteException(ErrorCodes.UNSUPPORTED_OPERATION, "Provider returned a cyclic document tree");
            }
            DocumentMetadata metadata = queryMetadata(node.document);
            if (!metadata.directory) {
                continue;
            }
            List<DocumentFile> children;
            try {
                int remaining = DELETE_MAX_ITEMS - items - pending.size();
                children = listChildrenStrict(node.document, remaining);
            } catch (KnoteException exception) {
                if (ErrorCodes.IO_ERROR.equals(exception.getCode())) {
                    throw new KnoteException(ErrorCodes.UNSUPPORTED_OPERATION, "Directory exceeds recursive delete budget or is incomplete");
                }
                throw exception;
            }
            for (DocumentFile child : children) {
                pending.push(new DeleteNode(child, node.depth + 1));
            }
        }
    }

    private PathPolicy.NormalizedPath normalizeForGrant(
        GrantStore.GrantAccess access,
        String path,
        boolean allowEmpty
    ) throws KnoteException {
        PathPolicy.NormalizedPath normalized = PathPolicy.normalize(path, allowEmpty);
        PathPolicy.requireCanonicalInput(path, normalized);
        if (access.record.kind.equals("document") && !normalized.value.isEmpty()) {
            throw new KnoteException(ErrorCodes.BAD_PATH, "Standalone document paths must be empty");
        }
        return normalized;
    }

    private void requireTree(GrantStore.GrantAccess access) throws KnoteException {
        if (!access.record.kind.equals("tree")) {
            throw new KnoteException(ErrorCodes.UNSUPPORTED_OPERATION, "Operation requires a tree grant");
        }
    }

    private KnoteException revokedOrReadOnly(GrantStore.GrantAccess access) {
        try {
            grants.require(access.record.grantId, true, true);
            return new KnoteException(ErrorCodes.UNSUPPORTED_OPERATION, "Provider rejected the operation");
        } catch (KnoteException exception) {
            return exception;
        }
    }

    private void verifyWrittenBytes(Uri uri, byte[] expected) throws KnoteException {
        MessageDigest expectedDigest = sha256();
        expectedDigest.update(expected);
        byte[] expectedHash = expectedDigest.digest();
        MessageDigest actualDigest = sha256();
        int total = 0;
        try {
            ParcelFileDescriptor descriptor = resolver.openFileDescriptor(uri, "r");
            if (descriptor == null) {
                throw new IOException("Provider returned no verification descriptor");
            }
            long descriptorSize = descriptor.getStatSize();
            if (descriptorSize >= 0 && descriptorSize != expected.length) {
                throw new IOException("Written size did not match");
            }
            try (InputStream input = new ParcelFileDescriptor.AutoCloseInputStream(descriptor)) {
                byte[] buffer = new byte[8192];
                int count;
                while ((count = input.read(buffer)) != -1) {
                    if (count == 0) {
                        continue;
                    }
                    if (count > expected.length - total) {
                        throw new IOException("Written content exceeded expected size");
                    }
                    actualDigest.update(buffer, 0, count);
                    total += count;
                }
            }
        } catch (IOException | SecurityException | IllegalArgumentException exception) {
            throw writeUncertain();
        }
        if (total != expected.length || !MessageDigest.isEqual(expectedHash, actualDigest.digest())) {
            throw writeUncertain();
        }
    }

    private byte[] mutationDigest(DocumentFile document, DocumentMetadata metadata) throws KnoteException {
        if (metadata.directory || supports(metadata.flags, DocumentsContract.Document.FLAG_VIRTUAL_DOCUMENT)) {
            return null;
        }
        if (metadata.size > MAX_MUTATION_DIGEST_BYTES) {
            throw new KnoteException(ErrorCodes.UNSUPPORTED_OPERATION, "Document is too large to verify safely for mutation");
        }
        MessageDigest digest = sha256();
        long total = 0;
        long deadline = System.currentTimeMillis() + MAX_MUTATION_DIGEST_MILLIS;
        try {
            ParcelFileDescriptor descriptor = resolver.openFileDescriptor(document.getUri(), "r");
            if (descriptor == null) {
                throw new IOException("Provider returned no digest descriptor");
            }
            long descriptorSize = descriptor.getStatSize();
            if (descriptorSize >= 0 && metadata.size >= 0 && descriptorSize != metadata.size) {
                throw new IOException("Document size changed before mutation");
            }
            try (InputStream input = new ParcelFileDescriptor.AutoCloseInputStream(descriptor)) {
                byte[] buffer = new byte[8192];
                int count;
                while ((count = input.read(buffer)) != -1) {
                    if (count == 0) {
                        continue;
                    }
                    if (count > MAX_MUTATION_DIGEST_BYTES - total || System.currentTimeMillis() > deadline) {
                        throw new IOException("Document exceeded digest limit");
                    }
                    digest.update(buffer, 0, count);
                    total += count;
                }
            }
        } catch (IOException | SecurityException | IllegalArgumentException exception) {
            throw new KnoteException(ErrorCodes.IO_ERROR, "Document could not be verified for mutation");
        }
        if (metadata.size >= 0 && total != metadata.size) {
            throw new KnoteException(ErrorCodes.IO_ERROR, "Document changed before mutation");
        }
        return digest.digest();
    }

    private static MessageDigest sha256() throws KnoteException {
        try {
            return MessageDigest.getInstance("SHA-256");
        } catch (NoSuchAlgorithmException exception) {
            throw new KnoteException(ErrorCodes.IO_ERROR, "SHA-256 is unavailable");
        }
    }

    private static KnoteException writeUncertain() {
        return new KnoteException(
            ErrorCodes.WRITE_COMMIT_UNCERTAIN,
            "Write may have changed provider content but could not be verified"
        );
    }

    private static KnoteException mutationUncertain(String operation) {
        return new KnoteException(
            ErrorCodes.MUTATION_COMMIT_UNCERTAIN,
            "Provider " + operation + " may have committed but its result could not be verified"
        );
    }

    private static KnoteException entryChanged() {
        return new KnoteException(ErrorCodes.ENTRY_CHANGED, "Document entry changed; refresh the granted tree");
    }

    private static boolean supports(long flags, int capability) {
        return (flags & capability) != 0;
    }

    private static boolean sameMimeType(String left, String right) {
        return left == null ? right == null : right != null && left.equalsIgnoreCase(right);
    }

    private static String encodeBase64(byte[] data) throws KnoteException {
        try {
            return Base64.encodeToString(data, Base64.NO_WRAP);
        } catch (OutOfMemoryError | IllegalArgumentException error) {
            throw new KnoteException(ErrorCodes.IO_ERROR, "File could not be encoded within memory limits");
        }
    }

    private static String parentPath(PathPolicy.NormalizedPath path) {
        int separator = path.value.lastIndexOf('/');
        return separator < 0 ? "" : path.value.substring(0, separator);
    }

    private static String joinPath(String parent, String child) {
        return parent.isEmpty() ? child : parent + "/" + child;
    }

    private static KnoteException revoked() {
        return new KnoteException(ErrorCodes.GRANT_REVOKED, "Persisted permission is missing or revoked");
    }

    private static KnoteException ioError() {
        return new KnoteException(ErrorCodes.IO_ERROR, "Document provider operation failed");
    }

    private static final class Resolved {
        final DocumentFile document;
        final PathPolicy.NormalizedPath path;
        final DocumentMetadata metadata;

        Resolved(DocumentFile document, PathPolicy.NormalizedPath path, DocumentMetadata metadata) {
            this.document = document;
            this.path = path;
            this.metadata = metadata;
        }
    }

    private static final class ParentAndName {
        final DocumentFile parent;
        final String name;

        ParentAndName(DocumentFile parent, String name) {
            this.parent = parent;
            this.name = name;
        }
    }

    private static final class DocumentMetadata {
        final String rawName;
        final String name;
        final String mimeType;
        final long size;
        final long lastModified;
        final long flags;
        final boolean directory;
        final boolean readable;
        final boolean writable;
        final boolean contentWritable;

        DocumentMetadata(
            String rawName,
            String name,
            String mimeType,
            long size,
            long lastModified,
            long flags,
            boolean directory,
            boolean readable,
            boolean writable,
            boolean contentWritable
        ) {
            this.rawName = rawName;
            this.name = name;
            this.mimeType = mimeType;
            this.size = size;
            this.lastModified = lastModified;
            this.flags = flags;
            this.directory = directory;
            this.readable = readable;
            this.writable = writable;
            this.contentWritable = contentWritable;
        }
    }

    private static final class DeleteNode {
        final DocumentFile document;
        final int depth;

        DeleteNode(DocumentFile document, int depth) {
            this.document = document;
            this.depth = depth;
        }
    }
}
