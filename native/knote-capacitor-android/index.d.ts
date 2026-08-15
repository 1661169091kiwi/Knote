import type { Plugin } from '@capacitor/core';

export type GrantKind = 'tree' | 'document';
export type EntryKind = 'file' | 'directory';
export type SearchEngine = 'auto' | 'bing' | 'duckduckgo' | 'mojeek';
/** Tree-relative, slash-separated, canonical Unicode NFC path; use "" for the grant root. */
export type RelativePath = string;

/**
 * Stable rejection codes. MUTATION_COMMIT_UNCERTAIN means a provider mutation may have
 * committed but its exact result could not be verified; inspect current state before retrying.
 */
export type KnoteAndroidErrorCode =
  | 'PICKER_CANCELLED'
  | 'BAD_GRANT'
  | 'GRANT_REVOKED'
  | 'READ_ONLY'
  | 'BAD_PATH'
  | 'NOT_FOUND'
  | 'TYPE_MISMATCH'
  | 'TARGET_EXISTS'
  | 'ENTRY_CHANGED'
  | 'UNSUPPORTED_OPERATION'
  | 'WRITE_COMMIT_UNCERTAIN'
  | 'MUTATION_COMMIT_UNCERTAIN'
  | 'IO_ERROR';

export interface GrantInfo {
  grantId: string;
  kind: GrantKind;
  displayName: string;
  writable: boolean;
  readable: boolean;
  persisted: boolean;
  valid: boolean;
}

export interface EntryMetadata {
  /** Opaque capability for this exact tree entry; empty for a grant root. */
  entryId: string;
  name: string;
  relativePath: RelativePath;
  kind: EntryKind;
  mimeType?: string;
  size?: number;
  lastModified?: number;
  readable: boolean;
  writable: boolean;
  /** True only when file bytes can be replaced, not merely renamed/deleted. */
  contentWritable: boolean;
}

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface WebSearchResult {
  ok: boolean;
  /** Actual fixed engine used, or auto when every attempt fails. */
  engine: SearchEngine;
  results: SearchResult[];
}

export interface KnoteAndroidPlugin extends Plugin {
  pickDocument(options?: {
    mimeTypes?: string[];
    /**
     * Defaults to true. False omits write access from this picker request, but it cannot
     * reliably downgrade write access that Android or the provider already persisted.
     */
    writable?: boolean;
  }): Promise<GrantInfo>;
  createDocument(options: {
    /** Must be a single canonical Unicode NFC name. */
    suggestedName: string;
    mimeType?: string;
  }): Promise<GrantInfo>;
  pickTree(options?: {
    /**
     * Defaults to true. False requests a persisted read-only tree grant, but cannot reliably
     * downgrade write access that Android or the provider already persisted.
     */
    writable?: boolean;
  }): Promise<GrantInfo>;
  /** Returns only stored grants that are currently readable and valid. */
  listGrants(): Promise<{ grants: GrantInfo[] }>;
  restoreGrant(options: { grantId: string }): Promise<GrantInfo>;
  releaseGrant(options: { grantId: string }): Promise<void>;
  list(options: {
    grantId: string;
    relativePath: RelativePath;
    /** Required for every non-root tree path; omit only for a grant root. */
    entryId?: string;
  }): Promise<{ entries: EntryMetadata[] }>;
  stat(options: {
    grantId: string;
    relativePath: RelativePath;
    /** Required when statting an already-bound non-root tree entry. */
    entryId?: string;
    /** Required instead of entryId when discovering a child below a non-root tree directory. */
    parentEntryId?: string;
  }): Promise<EntryMetadata>;
  readFile(options: {
    grantId: string;
    relativePath: RelativePath;
    /** Required for every non-root tree path; omit only for a standalone document root. */
    entryId?: string;
  }): Promise<{ data: string; metadata: EntryMetadata }>;
  /**
   * Provider writes are not generically atomic. WRITE_COMMIT_UNCERTAIN means bytes may
   * have changed and verification failed; re-read before deciding whether to retry.
   */
  writeFile(options: {
    grantId: string;
    relativePath: RelativePath;
    /** Required for every non-root tree path; omit only for a standalone document root. */
    entryId?: string;
    data: string;
  }): Promise<EntryMetadata>;
  createFile(options: {
    grantId: string;
    relativePath: RelativePath;
    /** Required when the new entry's parent is a non-root tree directory. */
    parentEntryId?: string;
    mimeType?: string;
  }): Promise<EntryMetadata>;
  createDirectory(options: {
    grantId: string;
    relativePath: RelativePath;
    /** Required when the new entry's parent is a non-root tree directory. */
    parentEntryId?: string;
  }): Promise<EntryMetadata>;
  rename(options: {
    grantId: string;
    relativePath: RelativePath;
    entryId: string;
    /** Must be a single canonical Unicode NFC name. */
    newName: string;
  }): Promise<EntryMetadata>;
  /** destinationPath is an existing destination directory within the same tree grant. */
  move(options: {
    grantId: string;
    relativePath: RelativePath;
    destinationPath: RelativePath;
    entryId: string;
    /** Required when destinationPath is a non-root tree directory. */
    destinationEntryId?: string;
  }): Promise<EntryMetadata>;
  delete(options: {
    grantId: string;
    relativePath: RelativePath;
    /** Required for tree children; omit for a standalone document root. */
    entryId?: string;
    recursive?: boolean;
  }): Promise<void>;
  webSearch(options: {
    /** Trimmed canonical Unicode NFC query, at most 256 code points. */
    query: string;
    max?: number;
    /** Defaults to auto, which tries Bing RSS before the other fixed engines. */
    engine?: SearchEngine;
    region?: string;
  }): Promise<WebSearchResult>;
  /** Cancels the currently active fixed-host search request, if any. */
  cancelWebSearch(): Promise<void>;
}

export declare const KnoteAndroid: KnoteAndroidPlugin;
export default KnoteAndroid;
