using Microsoft.Win32.SafeHandles;
using System;
using System.Collections;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Web.Script.Serialization;

namespace KnoteSandbox
{
    internal sealed class TaskManifest
    {
        internal string TaskId;
        internal string Executable;
        internal string[] Argv;
        internal string Cwd;
        internal string StagingRoot;
        internal int TimeoutMs;
        internal long MemoryBytes;
        internal int ProcessCount;
        internal int StdoutBytes;
        internal string RuntimeDirectory;
        internal StagingTreeSnapshot StagingSnapshot;
    }

    internal sealed class ErrorAttestation
    {
        public string code { get; set; }
        public string stage { get; set; }
        public long? nativeError { get; set; }
        public string message { get; set; }
    }

    internal sealed class Attestation
    {
        public string manifestVersion { get; set; }
        public string taskId { get; set; }
        public bool isolationEnforced { get; set; }
        public bool tokenIsAppContainer { get; set; }
        public bool appContainerSidVerified { get; set; }
        public string appContainerSid { get; set; }
        public bool jobAssigned { get; set; }
        public string jobAssignment { get; set; }
        public bool jobLimitsVerified { get; set; }
        public bool breakawayAllowed { get; set; }
        public bool stagingAcl { get; set; }
        public bool runtimeAclReadExecute { get; set; }
        public bool stagingHandlesPinned { get; set; }
        public bool executableIdentityVerified { get; set; }
        public string networkCapabilities { get; set; }
        public int? capabilityCount { get; set; }
        public bool? loopbackExempt { get; set; }
        public long? exitCode { get; set; }
        public long durationMs { get; set; }
        public long? peakProcessMemoryBytes { get; set; }
        public long? peakJobMemoryBytes { get; set; }
        public string stdout { get; set; }
        public string stderr { get; set; }
        public long stdoutCapturedBytes { get; set; }
        public long stderrCapturedBytes { get; set; }
        public int outputBudgetBytes { get; set; }
        public string termination { get; set; }
        public ErrorAttestation error { get; set; }

        internal static Attestation Create(string taskId)
        {
            return new Attestation
            {
                manifestVersion = "knote.sandbox-attestation.v1",
                taskId = taskId,
                isolationEnforced = false,
                tokenIsAppContainer = false,
                appContainerSidVerified = false,
                appContainerSid = null,
                jobAssigned = false,
                jobAssignment = "unknown",
                jobLimitsVerified = false,
                breakawayAllowed = false,
                stagingAcl = false,
                runtimeAclReadExecute = false,
                stagingHandlesPinned = false,
                executableIdentityVerified = false,
                networkCapabilities = "unknown",
                capabilityCount = null,
                loopbackExempt = null,
                exitCode = null,
                durationMs = 0,
                peakProcessMemoryBytes = null,
                peakJobMemoryBytes = null,
                stdout = String.Empty,
                stderr = String.Empty,
                stdoutCapturedBytes = 0,
                stderrCapturedBytes = 0,
                outputBudgetBytes = 0,
                termination = "POLICY_REJECTED",
                error = null
            };
        }
    }

    internal sealed class BrokerException : Exception
    {
        internal string Code { get; private set; }
        internal string Stage { get; private set; }
        internal long? NativeError { get; private set; }
        internal string Termination { get; private set; }

        internal BrokerException(string code, string stage, string message)
            : this(code, stage, message, null, "POLICY_REJECTED")
        {
        }

        internal BrokerException(
            string code,
            string stage,
            string message,
            long? nativeError,
            string termination)
            : base(message)
        {
            Code = code;
            Stage = stage;
            NativeError = nativeError;
            Termination = termination;
        }
    }

    internal static class ManifestParser
    {
        internal const string InputVersion = "knote.sandbox-task.v1";
        private const int MaxManifestChars = 1024 * 1024;
        private static readonly Regex TaskIdPattern = new Regex(
            "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$",
            RegexOptions.CultureInvariant);

        private static readonly string[] ExpectedFields = new[]
        {
            "manifestVersion",
            "taskId",
            "executable",
            "argv",
            "cwd",
            "stagingRoot",
            "timeoutMs",
            "memoryBytes",
            "processCount",
            "stdoutBytes"
        };

        internal static TaskManifest Parse(TextReader reader)
        {
            string json = ReadBounded(reader);
            JavaScriptSerializer serializer = new JavaScriptSerializer
            {
                MaxJsonLength = MaxManifestChars,
                RecursionLimit = 16
            };

            object parsed;
            try
            {
                parsed = serializer.DeserializeObject(json);
            }
            catch (Exception exception)
            {
                throw new BrokerException("MANIFEST_INVALID_JSON", "manifest", exception.Message);
            }

            Dictionary<string, object> root = parsed as Dictionary<string, object>;
            if (root == null)
            {
                throw new BrokerException("MANIFEST_NOT_OBJECT", "manifest", "The manifest must be a JSON object.");
            }

            if (root.Count != ExpectedFields.Length)
            {
                throw new BrokerException(
                    "MANIFEST_FIELDS_INVALID",
                    "manifest",
                    "The manifest must contain exactly the v1 fields.");
            }

            for (int index = 0; index < ExpectedFields.Length; index++)
            {
                if (!root.ContainsKey(ExpectedFields[index]))
                {
                    throw new BrokerException(
                        "MANIFEST_FIELD_MISSING",
                        "manifest",
                        "Missing manifest field: " + ExpectedFields[index] + ".");
                }
            }

            string version = RequireString(root, "manifestVersion", 64);
            if (!String.Equals(version, InputVersion, StringComparison.Ordinal))
            {
                throw new BrokerException(
                    "MANIFEST_VERSION_UNSUPPORTED",
                    "manifest",
                    "Expected manifestVersion " + InputVersion + ".");
            }

            TaskManifest manifest = new TaskManifest();
            manifest.TaskId = RequireString(root, "taskId", 128);
            if (!TaskIdPattern.IsMatch(manifest.TaskId))
            {
                throw new BrokerException(
                    "TASK_ID_INVALID",
                    "manifest",
                    "taskId must match [A-Za-z0-9][A-Za-z0-9._-]{0,127}.");
            }

            manifest.Executable = NormalizeAbsolutePath(RequireString(root, "executable", 32767), "executable", false);
            manifest.Cwd = NormalizeAbsolutePath(RequireString(root, "cwd", 32767), "cwd", true);
            manifest.StagingRoot = NormalizeAbsolutePath(RequireString(root, "stagingRoot", 32767), "stagingRoot", true);
            manifest.Argv = RequireArgv(root["argv"]);
            manifest.TimeoutMs = RequireInteger(root, "timeoutMs", 100, 600000);
            manifest.MemoryBytes = RequireLong(root, "memoryBytes", 32L * 1024L * 1024L, 8L * 1024L * 1024L * 1024L);
            manifest.ProcessCount = RequireInteger(root, "processCount", 1, 32);
            manifest.StdoutBytes = RequireInteger(root, "stdoutBytes", 1024, 16 * 1024 * 1024);

            ValidatePaths(manifest);
            ValidateCommandLine(manifest);
            return manifest;
        }

        private static string ReadBounded(TextReader reader)
        {
            StringBuilder builder = new StringBuilder();
            char[] buffer = new char[4096];
            while (true)
            {
                int read = reader.Read(buffer, 0, buffer.Length);
                if (read == 0)
                {
                    break;
                }

                if (builder.Length + read > MaxManifestChars)
                {
                    throw new BrokerException("MANIFEST_TOO_LARGE", "manifest", "The manifest exceeds 1 MiB.");
                }

                builder.Append(buffer, 0, read);
            }

            if (builder.Length == 0)
            {
                throw new BrokerException("MANIFEST_EMPTY", "manifest", "A JSON manifest is required on stdin.");
            }

            return builder.ToString();
        }

        private static string RequireString(Dictionary<string, object> root, string name, int maximumLength)
        {
            string value = root[name] as string;
            if (String.IsNullOrEmpty(value) || value.Length > maximumLength || value.IndexOf('\0') >= 0)
            {
                throw new BrokerException("MANIFEST_FIELD_INVALID", "manifest", name + " is invalid.");
            }

            return value;
        }

        private static int RequireInteger(Dictionary<string, object> root, string name, int minimum, int maximum)
        {
            long value = RequireIntegralValue(root[name], name);
            if (value < minimum || value > maximum)
            {
                throw new BrokerException(
                    "MANIFEST_RANGE_INVALID",
                    "manifest",
                    name + " must be between " + minimum + " and " + maximum + ".");
            }

            return (int)value;
        }

        private static long RequireLong(Dictionary<string, object> root, string name, long minimum, long maximum)
        {
            long value = RequireIntegralValue(root[name], name);
            if (value < minimum || value > maximum)
            {
                throw new BrokerException(
                    "MANIFEST_RANGE_INVALID",
                    "manifest",
                    name + " must be between " + minimum + " and " + maximum + ".");
            }

            return value;
        }

        private static long RequireIntegralValue(object value, string name)
        {
            if (value is int)
            {
                return (int)value;
            }

            if (value is long)
            {
                return (long)value;
            }

            throw new BrokerException("MANIFEST_TYPE_INVALID", "manifest", name + " must be an integer.");
        }

        private static string[] RequireArgv(object value)
        {
            object[] values = value as object[];
            if (values == null || values.Length > 128)
            {
                throw new BrokerException("ARGV_INVALID", "manifest", "argv must be an array with at most 128 strings.");
            }

            string[] result = new string[values.Length];
            int totalLength = 0;
            for (int index = 0; index < values.Length; index++)
            {
                string argument = values[index] as string;
                if (argument == null || argument.Length > 8192 || argument.IndexOf('\0') >= 0)
                {
                    throw new BrokerException("ARGV_INVALID", "manifest", "Every argv item must be a string of at most 8192 characters.");
                }

                totalLength += argument.Length;
                if (totalLength > 24576)
                {
                    throw new BrokerException("ARGV_TOO_LARGE", "manifest", "argv exceeds the aggregate length limit.");
                }

                result[index] = argument;
            }

            return result;
        }

        private static string NormalizeAbsolutePath(string value, string field, bool directory)
        {
            if (!Regex.IsMatch(value, "^[A-Za-z]:[\\\\/]", RegexOptions.CultureInvariant) ||
                value.StartsWith("\\\\?\\", StringComparison.Ordinal) ||
                value.StartsWith("\\\\.\\", StringComparison.Ordinal) ||
                value.IndexOf(':', 2) >= 0)
            {
                throw new BrokerException("PATH_NOT_LOCAL_ABSOLUTE", "manifest", field + " must be an absolute local drive path.");
            }

            string fullPath;
            try
            {
                fullPath = Path.GetFullPath(value);
            }
            catch (Exception exception)
            {
                throw new BrokerException("PATH_INVALID", "manifest", field + ": " + exception.Message);
            }

            if (directory)
            {
                string root = Path.GetPathRoot(fullPath);
                while (fullPath.Length > root.Length &&
                       (fullPath.EndsWith("\\", StringComparison.Ordinal) || fullPath.EndsWith("/", StringComparison.Ordinal)))
                {
                    fullPath = fullPath.Substring(0, fullPath.Length - 1);
                }
            }

            return fullPath;
        }

        private static void ValidatePaths(TaskManifest manifest)
        {
            if (!Directory.Exists(manifest.StagingRoot))
            {
                throw new BrokerException("STAGING_NOT_FOUND", "manifest", "stagingRoot does not exist.");
            }

            if (!Directory.Exists(manifest.Cwd))
            {
                throw new BrokerException("CWD_NOT_FOUND", "manifest", "cwd does not exist.");
            }

            if (!File.Exists(manifest.Executable) ||
                !String.Equals(Path.GetExtension(manifest.Executable), ".exe", StringComparison.OrdinalIgnoreCase))
            {
                throw new BrokerException("EXECUTABLE_NOT_FOUND", "manifest", "executable must name an existing .exe file.");
            }

            if (!PathPolicy.IsWithin(manifest.Cwd, manifest.StagingRoot, true))
            {
                throw new BrokerException("CWD_OUTSIDE_STAGING", "manifest", "cwd must be inside stagingRoot.");
            }

            if (!PathPolicy.IsWithin(manifest.Executable, manifest.StagingRoot, false))
            {
                throw new BrokerException("EXECUTABLE_OUTSIDE_STAGING", "manifest", "executable must be copied inside stagingRoot.");
            }

            manifest.RuntimeDirectory = Path.GetDirectoryName(manifest.Executable);
            if (String.Equals(manifest.RuntimeDirectory, manifest.StagingRoot, StringComparison.OrdinalIgnoreCase))
            {
                throw new BrokerException(
                    "RUNTIME_DIRECTORY_REQUIRED",
                    "manifest",
                    "executable must be in a dedicated subdirectory below stagingRoot.");
            }

            if (PathPolicy.IsWithin(manifest.Cwd, manifest.RuntimeDirectory, true))
            {
                throw new BrokerException("CWD_INSIDE_RUNTIME", "manifest", "cwd cannot be inside the read-only runtime directory.");
            }

            manifest.StagingSnapshot = PathPolicy.ValidateStagingTree(manifest.StagingRoot);
        }

        private static void ValidateCommandLine(TaskManifest manifest)
        {
            string commandLine = CommandLineBuilder.Build(manifest.Executable, manifest.Argv);
            if (commandLine.Length > 30000)
            {
                throw new BrokerException("COMMAND_LINE_TOO_LARGE", "manifest", "The Windows command line exceeds 30000 characters.");
            }
        }
    }

    internal static class PathPolicy
    {
        internal const int MaximumStagingEntries = 10000;

        internal static bool IsWithin(string childPath, string parentPath, bool allowEqual)
        {
            if (allowEqual && String.Equals(childPath, parentPath, StringComparison.OrdinalIgnoreCase))
            {
                return true;
            }

            string prefix = parentPath.EndsWith("\\", StringComparison.Ordinal)
                ? parentPath
                : parentPath + "\\";
            return childPath.StartsWith(prefix, StringComparison.OrdinalIgnoreCase);
        }

        internal static StagingTreeSnapshot ValidateStagingTree(string stagingRoot)
        {
            return PinnedStagingTree.CaptureSnapshot(stagingRoot);
        }
    }

    internal sealed class StagingObjectSnapshot
    {
        internal string Path;
        internal string FinalPath;
        internal bool IsDirectory;
        internal uint FileAttributes;
        internal uint ReparseTag;
        internal uint VolumeSerialNumber;
        internal ulong FileIndex;
        internal uint NumberOfLinks;
        internal ulong FileSize;
        internal ulong CreationTime;
        internal ulong LastWriteTime;

        internal string IdentityKey
        {
            get
            {
                return VolumeSerialNumber.ToString("x8") + ":" + FileIndex.ToString("x16");
            }
        }
    }

    internal sealed class StagingTreeSnapshot
    {
        internal readonly Dictionary<string, StagingObjectSnapshot> Entries =
            new Dictionary<string, StagingObjectSnapshot>(StringComparer.OrdinalIgnoreCase);
        internal string RootFinalPath;
    }

    internal sealed class PinnedStagingObject : IDisposable
    {
        internal SafeFileHandle Handle { get; private set; }
        internal StagingObjectSnapshot Information { get; private set; }

        internal PinnedStagingObject(SafeFileHandle handle, StagingObjectSnapshot information)
        {
            Handle = handle;
            Information = information;
        }

        public void Dispose()
        {
            if (Handle != null)
            {
                Handle.Dispose();
                Handle = null;
            }
        }
    }

    internal sealed class PinnedStagingTree : IDisposable
    {
        private const int FileAttributeTagInfo = 9;
        private readonly List<PinnedStagingObject> pinnedObjects = new List<PinnedStagingObject>();
        private readonly Dictionary<string, PinnedStagingObject> stagingObjects =
            new Dictionary<string, PinnedStagingObject>(StringComparer.OrdinalIgnoreCase);
        private readonly Dictionary<string, string> identityPaths =
            new Dictionary<string, string>(StringComparer.Ordinal);
        private string stagingRoot;
        private string stagingRootFinalPath;

        private PinnedStagingTree()
        {
        }

        internal static StagingTreeSnapshot CaptureSnapshot(string stagingRoot)
        {
            StagingTreeSnapshot snapshot = new StagingTreeSnapshot();
            Dictionary<string, string> identities = new Dictionary<string, string>(StringComparer.Ordinal);
            Queue<string> directories = new Queue<string>();
            int entryCount = 0;

            using (PinnedStagingObject root = OpenAndValidate(
                stagingRoot,
                true,
                null,
                "STAGING_HANDLE_OPEN_FAILED"))
            {
                snapshot.RootFinalPath = root.Information.FinalPath;
                AddSnapshotObject(snapshot, identities, root.Information);
            }
            directories.Enqueue(stagingRoot);

            while (directories.Count > 0)
            {
                string directory = directories.Dequeue();
                string[] children;
                try
                {
                    children = Directory.GetFileSystemEntries(directory);
                }
                catch (Exception exception)
                {
                    throw new BrokerException(
                        "STAGING_ENUMERATION_FAILED",
                        "handlePinning",
                        directory + ": " + exception.Message);
                }

                for (int index = 0; index < children.Length; index++)
                {
                    entryCount++;
                    if (entryCount > PathPolicy.MaximumStagingEntries)
                    {
                        throw new BrokerException(
                            "STAGING_TOO_LARGE",
                            "handlePinning",
                            "stagingRoot contains more than " + PathPolicy.MaximumStagingEntries + " entries.");
                    }

                    string child = NormalizePath(children[index], false);
                    FileAttributes attributes;
                    try
                    {
                        attributes = File.GetAttributes(child);
                    }
                    catch (Exception exception)
                    {
                        throw new BrokerException(
                            "STAGING_ENTRY_INVALID",
                            "handlePinning",
                            child + ": " + exception.Message);
                    }

                    bool isDirectory = (attributes & FileAttributes.Directory) != 0;
                    using (PinnedStagingObject observed = OpenAndValidate(
                        child,
                        isDirectory,
                        snapshot.RootFinalPath,
                        "STAGING_HANDLE_OPEN_FAILED"))
                    {
                        AddSnapshotObject(snapshot, identities, observed.Information);
                    }
                    if (isDirectory)
                    {
                        directories.Enqueue(child);
                    }
                }
            }

            return snapshot;
        }

        internal static PinnedStagingTree Create(TaskManifest manifest)
        {
            if (manifest.StagingSnapshot == null)
            {
                throw new BrokerException(
                    "STAGING_SNAPSHOT_MISSING",
                    "handlePinning",
                    "The validated staging snapshot is missing.");
            }

            PinnedStagingTree result = new PinnedStagingTree();
            result.stagingRoot = manifest.StagingRoot;
            try
            {
                result.PinAncestors(manifest.StagingSnapshot);
                result.PinSnapshotEntries(manifest.StagingSnapshot);
                result.VerifyTreeMatchesPins();
                return result;
            }
            catch
            {
                result.Dispose();
                throw;
            }
        }

        internal void PinCurrentTree(TaskManifest manifest)
        {
            StagingTreeSnapshot current = CaptureSnapshot(stagingRoot);
            if (!String.Equals(current.RootFinalPath, stagingRootFinalPath, StringComparison.OrdinalIgnoreCase))
            {
                throw TreeChanged("stagingRoot resolved to a different final path.");
            }

            foreach (KeyValuePair<string, PinnedStagingObject> existing in stagingObjects)
            {
                StagingObjectSnapshot observed;
                if (!current.Entries.TryGetValue(existing.Key, out observed))
                {
                    throw TreeChanged("A pinned staging object disappeared: " + existing.Key + ".");
                }

                StagingObjectSnapshot held = QueryAndValidate(
                    existing.Value.Handle,
                    existing.Key,
                    existing.Value.Information.IsDirectory,
                    stagingRootFinalPath);
                EnsureUnchanged(observed, held, "STAGING_OBJECT_REPLACED");
            }

            List<StagingObjectSnapshot> additions = OrderedEntries(current, stagingObjects);
            for (int index = 0; index < additions.Count; index++)
            {
                StagingObjectSnapshot expected = additions[index];
                if (!IsBrokerSupportPath(manifest, expected.Path))
                {
                    throw TreeChanged("An unexpected path appeared after the validated snapshot: " + expected.Path + ".");
                }
                PinnedStagingObject pinned = OpenAndValidate(
                    expected.Path,
                    expected.IsDirectory,
                    stagingRootFinalPath,
                    "STAGING_OBJECT_REPLACED");
                try
                {
                    EnsureUnchanged(expected, pinned.Information, "STAGING_OBJECT_REPLACED");
                    AddPinnedObject(pinned, true);
                    pinned = null;
                }
                finally
                {
                    if (pinned != null)
                    {
                        pinned.Dispose();
                    }
                }
            }

            VerifyTreeMatchesPins();
        }

        private static bool IsBrokerSupportPath(TaskManifest manifest, string path)
        {
            string temporaryDirectory = Path.Combine(manifest.StagingRoot, ".knote-tmp");
            string profileDirectory = Path.Combine(manifest.StagingRoot, ".knote-profile");
            return String.Equals(path, temporaryDirectory, StringComparison.OrdinalIgnoreCase) ||
                String.Equals(path, profileDirectory, StringComparison.OrdinalIgnoreCase) ||
                String.Equals(path, Path.Combine(profileDirectory, "AppData"), StringComparison.OrdinalIgnoreCase) ||
                String.Equals(path, Path.Combine(profileDirectory, "AppData", "Local"), StringComparison.OrdinalIgnoreCase) ||
                String.Equals(path, Path.Combine(profileDirectory, "AppData", "Roaming"), StringComparison.OrdinalIgnoreCase);
        }

        internal void RevalidateCritical(TaskManifest manifest)
        {
            foreach (KeyValuePair<string, PinnedStagingObject> item in stagingObjects)
            {
                StagingObjectSnapshot current = QueryAndValidate(
                    item.Value.Handle,
                    item.Key,
                    item.Value.Information.IsDirectory,
                    stagingRootFinalPath);
                EnsureUnchanged(item.Value.Information, current, "STAGING_PIN_REVALIDATION_FAILED");
            }

            RevalidateNamedObject(manifest.StagingRoot, true, "stagingRoot");
            RevalidateNamedObject(manifest.RuntimeDirectory, true, "runtime directory");
            RevalidateNamedObject(manifest.Cwd, true, "cwd");
            RevalidateNamedObject(manifest.Executable, false, "executable");
        }

        private void PinAncestors(StagingTreeSnapshot expectedSnapshot)
        {
            string volumeRoot = Path.GetPathRoot(stagingRoot);
            List<string> ancestors = new List<string>();
            string current = stagingRoot;
            while (!String.Equals(current, volumeRoot, StringComparison.OrdinalIgnoreCase))
            {
                ancestors.Add(current);
                current = Path.GetDirectoryName(current);
                if (String.IsNullOrEmpty(current))
                {
                    throw new BrokerException(
                        "STAGING_ANCESTOR_INVALID",
                        "handlePinning",
                        "Could not determine the stagingRoot ancestor chain.");
                }
            }
            ancestors.Reverse();

            for (int index = 0; index < ancestors.Count; index++)
            {
                string ancestor = ancestors[index];
                PinnedStagingObject pinned = OpenAndValidate(
                    ancestor,
                    true,
                    null,
                    "STAGING_ANCESTOR_OPEN_FAILED");
                bool isStagingRoot = String.Equals(ancestor, stagingRoot, StringComparison.OrdinalIgnoreCase);
                try
                {
                    if (isStagingRoot)
                    {
                        StagingObjectSnapshot expected;
                        if (!expectedSnapshot.Entries.TryGetValue(stagingRoot, out expected))
                        {
                            throw new BrokerException(
                                "STAGING_SNAPSHOT_INVALID",
                                "handlePinning",
                                "The staging snapshot does not contain stagingRoot.");
                        }
                        EnsureUnchanged(expected, pinned.Information, "STAGING_OBJECT_REPLACED");
                        stagingRootFinalPath = pinned.Information.FinalPath;
                    }

                    AddPinnedObject(pinned, isStagingRoot);
                    pinned = null;
                }
                finally
                {
                    if (pinned != null)
                    {
                        pinned.Dispose();
                    }
                }
            }
        }

        private void PinSnapshotEntries(StagingTreeSnapshot snapshot)
        {
            List<StagingObjectSnapshot> entries = OrderedEntries(snapshot, stagingObjects);
            for (int index = 0; index < entries.Count; index++)
            {
                StagingObjectSnapshot expected = entries[index];
                PinnedStagingObject pinned = OpenAndValidate(
                    expected.Path,
                    expected.IsDirectory,
                    stagingRootFinalPath,
                    "STAGING_OBJECT_REPLACED");
                try
                {
                    EnsureUnchanged(expected, pinned.Information, "STAGING_OBJECT_REPLACED");
                    AddPinnedObject(pinned, true);
                    pinned = null;
                }
                finally
                {
                    if (pinned != null)
                    {
                        pinned.Dispose();
                    }
                }
            }
        }

        private void RevalidateNamedObject(string path, bool isDirectory, string label)
        {
            PinnedStagingObject held;
            if (!stagingObjects.TryGetValue(path, out held) || held.Information.IsDirectory != isDirectory)
            {
                throw new BrokerException(
                    "CRITICAL_PATH_NOT_PINNED",
                    "handlePinning",
                    label + " is not represented by the pinned staging path.");
            }

            using (PinnedStagingObject resolved = OpenAndValidate(
                path,
                isDirectory,
                stagingRootFinalPath,
                "CRITICAL_PATH_REVALIDATION_FAILED"))
            {
                EnsureUnchanged(held.Information, resolved.Information, "CRITICAL_PATH_REVALIDATION_FAILED");
            }
        }

        private void AddPinnedObject(PinnedStagingObject pinned, bool stagingObject)
        {
            string otherPath;
            if (identityPaths.TryGetValue(pinned.Information.IdentityKey, out otherPath))
            {
                throw new BrokerException(
                    "STAGING_ALIAS_REJECTED",
                    "handlePinning",
                    "Two paths resolved to the same file identity: " + otherPath + " and " + pinned.Information.Path + ".");
            }
            identityPaths.Add(pinned.Information.IdentityKey, pinned.Information.Path);

            if (stagingObject)
            {
                if (stagingObjects.ContainsKey(pinned.Information.Path))
                {
                    identityPaths.Remove(pinned.Information.IdentityKey);
                    throw new BrokerException(
                        "STAGING_ALIAS_REJECTED",
                        "handlePinning",
                        "A staging path was enumerated more than once: " + pinned.Information.Path + ".");
                }
                stagingObjects.Add(pinned.Information.Path, pinned);
            }
            pinnedObjects.Add(pinned);
        }

        private void VerifyTreeMatchesPins()
        {
            Queue<string> directories = new Queue<string>();
            HashSet<string> observed = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            directories.Enqueue(stagingRoot);
            observed.Add(stagingRoot);

            while (directories.Count > 0)
            {
                string directory = directories.Dequeue();
                string[] children;
                try
                {
                    children = Directory.GetFileSystemEntries(directory);
                }
                catch (Exception exception)
                {
                    throw new BrokerException(
                        "STAGING_ENUMERATION_FAILED",
                        "handlePinning",
                        directory + ": " + exception.Message);
                }

                for (int index = 0; index < children.Length; index++)
                {
                    string child = NormalizePath(children[index], false);
                    PinnedStagingObject pinned;
                    if (!stagingObjects.TryGetValue(child, out pinned) || !observed.Add(child))
                    {
                        throw TreeChanged("An unpinned or duplicate staging path was observed: " + child + ".");
                    }
                    if (pinned.Information.IsDirectory)
                    {
                        directories.Enqueue(child);
                    }
                }
            }

            if (observed.Count != stagingObjects.Count)
            {
                throw TreeChanged("The pinned staging path set did not match a final enumeration.");
            }
        }

        private static List<StagingObjectSnapshot> OrderedEntries(
            StagingTreeSnapshot snapshot,
            Dictionary<string, PinnedStagingObject> excluded)
        {
            List<StagingObjectSnapshot> entries = new List<StagingObjectSnapshot>();
            foreach (KeyValuePair<string, StagingObjectSnapshot> item in snapshot.Entries)
            {
                if (!excluded.ContainsKey(item.Key))
                {
                    entries.Add(item.Value);
                }
            }
            entries.Sort(delegate(StagingObjectSnapshot left, StagingObjectSnapshot right)
            {
                int length = left.Path.Length.CompareTo(right.Path.Length);
                return length != 0
                    ? length
                    : StringComparer.OrdinalIgnoreCase.Compare(left.Path, right.Path);
            });
            return entries;
        }

        private static void AddSnapshotObject(
            StagingTreeSnapshot snapshot,
            Dictionary<string, string> identities,
            StagingObjectSnapshot information)
        {
            if (snapshot.Entries.ContainsKey(information.Path))
            {
                throw new BrokerException(
                    "STAGING_ALIAS_REJECTED",
                    "handlePinning",
                    "A staging path was enumerated more than once: " + information.Path + ".");
            }

            string otherPath;
            if (identities.TryGetValue(information.IdentityKey, out otherPath))
            {
                throw new BrokerException(
                    "STAGING_ALIAS_REJECTED",
                    "handlePinning",
                    "Two staging paths resolved to the same file identity: " + otherPath + " and " + information.Path + ".");
            }
            identities.Add(information.IdentityKey, information.Path);
            snapshot.Entries.Add(information.Path, information);
        }

        private static PinnedStagingObject OpenAndValidate(
            string path,
            bool isDirectory,
            string rootFinalPath,
            string openFailureCode)
        {
            uint access = isDirectory ? NativeMethods.FILE_READ_ATTRIBUTES : NativeMethods.GENERIC_READ;
            uint share = isDirectory
                ? NativeMethods.FILE_SHARE_READ | NativeMethods.FILE_SHARE_WRITE
                : NativeMethods.FILE_SHARE_READ;
            uint flags = NativeMethods.FILE_FLAG_OPEN_REPARSE_POINT;
            if (isDirectory)
            {
                flags |= NativeMethods.FILE_FLAG_BACKUP_SEMANTICS;
            }

            SafeFileHandle handle = NativeMethods.CreateFileW(
                path,
                access,
                share,
                IntPtr.Zero,
                NativeMethods.OPEN_EXISTING,
                flags,
                IntPtr.Zero);
            if (handle == null || handle.IsInvalid)
            {
                int error = Marshal.GetLastWin32Error();
                if (handle != null)
                {
                    handle.Dispose();
                }
                throw NativeFailure(openFailureCode, "CreateFileW", error);
            }

            try
            {
                StagingObjectSnapshot information = QueryAndValidate(handle, path, isDirectory, rootFinalPath);
                return new PinnedStagingObject(handle, information);
            }
            catch
            {
                handle.Dispose();
                throw;
            }
        }

        private static StagingObjectSnapshot QueryAndValidate(
            SafeFileHandle handle,
            string path,
            bool expectedDirectory,
            string rootFinalPath)
        {
            NativeMethods.BY_HANDLE_FILE_INFORMATION basic;
            if (!NativeMethods.GetFileInformationByHandle(handle.DangerousGetHandle(), out basic))
            {
                int error = Marshal.GetLastWin32Error();
                throw NativeFailure("STAGING_IDENTITY_QUERY_FAILED", "GetFileInformationByHandle", error);
            }

            NativeMethods.FILE_ATTRIBUTE_TAG_INFO tag;
            if (!NativeMethods.GetFileInformationByHandleEx(
                handle.DangerousGetHandle(),
                FileAttributeTagInfo,
                out tag,
                (uint)Marshal.SizeOf(typeof(NativeMethods.FILE_ATTRIBUTE_TAG_INFO))))
            {
                int error = Marshal.GetLastWin32Error();
                throw NativeFailure("STAGING_ATTRIBUTE_QUERY_FAILED", "GetFileInformationByHandleEx", error);
            }

            bool isDirectory = (tag.FileAttributes & NativeMethods.FILE_ATTRIBUTE_DIRECTORY) != 0;
            if (isDirectory != expectedDirectory ||
                ((basic.FileAttributes & NativeMethods.FILE_ATTRIBUTE_DIRECTORY) != 0) != isDirectory)
            {
                throw new BrokerException(
                    "STAGING_OBJECT_TYPE_CHANGED",
                    "handlePinning",
                    "A staging object did not have the expected directory/file type: " + path + ".");
            }
            if ((tag.FileAttributes & NativeMethods.FILE_ATTRIBUTE_REPARSE_POINT) != 0 ||
                (basic.FileAttributes & NativeMethods.FILE_ATTRIBUTE_REPARSE_POINT) != 0 ||
                tag.ReparseTag != 0)
            {
                throw new BrokerException(
                    "REPARSE_POINT_REJECTED",
                    "handlePinning",
                    "Reparse points are not allowed in staging or its pinned ancestor chain.");
            }
            if (!isDirectory && basic.NumberOfLinks != 1)
            {
                throw new BrokerException(
                    "HARDLINK_REJECTED",
                    "handlePinning",
                    "Hard-linked files are not allowed in stagingRoot.");
            }

            string normalizedPath = NormalizePath(path, isDirectory);
            string finalPath = QueryFinalPath(handle, isDirectory);
            if (!String.Equals(normalizedPath, finalPath, StringComparison.OrdinalIgnoreCase))
            {
                throw new BrokerException(
                    "STAGING_PATH_ALIAS_REJECTED",
                    "handlePinning",
                    "The opened object final path did not match its normalized path: " + path + ".");
            }
            if (rootFinalPath != null && !PathPolicy.IsWithin(finalPath, rootFinalPath, true))
            {
                throw new BrokerException(
                    "STAGING_FINAL_PATH_OUTSIDE_ROOT",
                    "handlePinning",
                    "An opened staging object resolved outside the pinned stagingRoot.");
            }

            return new StagingObjectSnapshot
            {
                Path = normalizedPath,
                FinalPath = finalPath,
                IsDirectory = isDirectory,
                FileAttributes = tag.FileAttributes,
                ReparseTag = tag.ReparseTag,
                VolumeSerialNumber = basic.VolumeSerialNumber,
                FileIndex = ((ulong)basic.FileIndexHigh << 32) | basic.FileIndexLow,
                NumberOfLinks = basic.NumberOfLinks,
                FileSize = ((ulong)basic.FileSizeHigh << 32) | basic.FileSizeLow,
                CreationTime = ((ulong)basic.CreationTime.HighDateTime << 32) | basic.CreationTime.LowDateTime,
                LastWriteTime = ((ulong)basic.LastWriteTime.HighDateTime << 32) | basic.LastWriteTime.LowDateTime
            };
        }

        private static string QueryFinalPath(SafeFileHandle handle, bool isDirectory)
        {
            int capacity = 512;
            while (capacity <= 32768)
            {
                StringBuilder buffer = new StringBuilder(capacity);
                uint length = NativeMethods.GetFinalPathNameByHandleW(handle, buffer, (uint)capacity, 0);
                if (length == 0)
                {
                    int error = Marshal.GetLastWin32Error();
                    throw NativeFailure("STAGING_FINAL_PATH_QUERY_FAILED", "GetFinalPathNameByHandleW", error);
                }
                if (length < capacity)
                {
                    return NormalizeFinalPath(buffer.ToString(), isDirectory);
                }
                if (length > 32767)
                {
                    break;
                }
                capacity = checked((int)length + 1);
            }

            throw new BrokerException(
                "STAGING_FINAL_PATH_INVALID",
                "handlePinning",
                "An opened object final path exceeded the supported path length.");
        }

        private static string NormalizeFinalPath(string path, bool isDirectory)
        {
            const string extendedPrefix = @"\\?\";
            const string extendedUncPrefix = @"\\?\UNC\";
            if (path.StartsWith(extendedUncPrefix, StringComparison.OrdinalIgnoreCase))
            {
                throw new BrokerException(
                    "STAGING_FINAL_PATH_INVALID",
                    "handlePinning",
                    "An opened object resolved to a non-local path.");
            }
            if (path.StartsWith(extendedPrefix, StringComparison.Ordinal))
            {
                path = path.Substring(extendedPrefix.Length);
            }
            return NormalizePath(path, isDirectory);
        }

        private static string NormalizePath(string path, bool isDirectory)
        {
            string fullPath;
            try
            {
                fullPath = Path.GetFullPath(path);
            }
            catch (Exception exception)
            {
                throw new BrokerException("STAGING_PATH_INVALID", "handlePinning", exception.Message);
            }

            if (!Regex.IsMatch(fullPath, "^[A-Za-z]:[\\\\]", RegexOptions.CultureInvariant))
            {
                throw new BrokerException(
                    "STAGING_FINAL_PATH_INVALID",
                    "handlePinning",
                    "An opened object did not resolve to an absolute local drive path.");
            }
            if (isDirectory)
            {
                string root = Path.GetPathRoot(fullPath);
                while (fullPath.Length > root.Length && fullPath.EndsWith("\\", StringComparison.Ordinal))
                {
                    fullPath = fullPath.Substring(0, fullPath.Length - 1);
                }
            }
            return fullPath;
        }

        private static void EnsureUnchanged(
            StagingObjectSnapshot expected,
            StagingObjectSnapshot actual,
            string code)
        {
            bool unchanged =
                expected.VolumeSerialNumber == actual.VolumeSerialNumber &&
                expected.FileIndex == actual.FileIndex &&
                expected.IsDirectory == actual.IsDirectory &&
                expected.FileAttributes == actual.FileAttributes &&
                expected.ReparseTag == actual.ReparseTag &&
                expected.NumberOfLinks == actual.NumberOfLinks &&
                String.Equals(expected.Path, actual.Path, StringComparison.OrdinalIgnoreCase) &&
                String.Equals(expected.FinalPath, actual.FinalPath, StringComparison.OrdinalIgnoreCase);
            if (!expected.IsDirectory)
            {
                unchanged = unchanged &&
                    expected.FileSize == actual.FileSize &&
                    expected.CreationTime == actual.CreationTime &&
                    expected.LastWriteTime == actual.LastWriteTime;
            }
            if (!unchanged)
            {
                throw new BrokerException(
                    code,
                    "handlePinning",
                    "A staging object changed identity or security-relevant metadata: " + expected.Path + ".");
            }
        }

        private static BrokerException NativeFailure(string code, string operation, int error)
        {
            return new BrokerException(
                code,
                "handlePinning",
                operation + " failed with Win32 error " + error + ": " + new Win32Exception(error).Message,
                error,
                "POLICY_REJECTED");
        }

        private static BrokerException TreeChanged(string message)
        {
            return new BrokerException("STAGING_TREE_CHANGED", "handlePinning", message);
        }

        public void Dispose()
        {
            for (int index = pinnedObjects.Count - 1; index >= 0; index--)
            {
                pinnedObjects[index].Dispose();
            }
            pinnedObjects.Clear();
            stagingObjects.Clear();
            identityPaths.Clear();
        }
    }

    internal static class CommandLineBuilder
    {
        internal static string Build(string executable, string[] argv)
        {
            StringBuilder builder = new StringBuilder();
            builder.Append(Quote(executable));
            for (int index = 0; index < argv.Length; index++)
            {
                builder.Append(' ');
                builder.Append(Quote(argv[index]));
            }

            return builder.ToString();
        }

        private static string Quote(string value)
        {
            if (value.Length > 0 && value.IndexOfAny(new[] { ' ', '\t', '\n', '\v', '"' }) < 0)
            {
                return value;
            }

            StringBuilder builder = new StringBuilder();
            builder.Append('"');
            int backslashes = 0;
            for (int index = 0; index < value.Length; index++)
            {
                char current = value[index];
                if (current == '\\')
                {
                    backslashes++;
                    continue;
                }

                if (current == '"')
                {
                    builder.Append('\\', backslashes * 2 + 1);
                    builder.Append('"');
                    backslashes = 0;
                    continue;
                }

                builder.Append('\\', backslashes);
                backslashes = 0;
                builder.Append(current);
            }

            builder.Append('\\', backslashes * 2);
            builder.Append('"');
            return builder.ToString();
        }
    }

    internal sealed class AppContainerProfile : IDisposable
    {
        internal string Name { get; private set; }
        internal IntPtr Sid { get; private set; }
        internal string SidString { get; private set; }
        private bool created;

        private AppContainerProfile()
        {
        }

        internal static AppContainerProfile Create()
        {
            AppContainerProfile profile = new AppContainerProfile();
            profile.Name = "KnoteSandbox." + Guid.NewGuid().ToString("N");
            IntPtr sid;

            int result = NativeMethods.CreateAppContainerProfile(
                profile.Name,
                profile.Name,
                "Knote native sandbox task",
                IntPtr.Zero,
                0,
                out sid);

            if (result == unchecked((int)0x800700b7))
            {
                result = NativeMethods.DeriveAppContainerSidFromAppContainerName(profile.Name, out sid);
            }
            else if (result >= 0)
            {
                profile.created = true;
            }

            profile.Sid = sid;

            if (result < 0 || profile.Sid == IntPtr.Zero)
            {
                profile.Dispose();
                Exception exception = Marshal.GetExceptionForHR(result);
                throw new BrokerException(
                    "APPCONTAINER_PROFILE_CREATE_FAILED",
                    "CreateAppContainerProfile",
                    exception == null ? "CreateAppContainerProfile failed." : exception.Message,
                    result,
                    "POLICY_REJECTED");
            }

            IntPtr stringSid = IntPtr.Zero;
            try
            {
                if (!NativeMethods.ConvertSidToStringSidW(profile.Sid, out stringSid))
                {
                    int error = Marshal.GetLastWin32Error();
                    throw SandboxRunner.Win32Failure(
                        "APPCONTAINER_SID_CONVERSION_FAILED",
                        "ConvertSidToStringSidW",
                        error,
                        "POLICY_REJECTED");
                }

                profile.SidString = Marshal.PtrToStringUni(stringSid);
            }
            catch
            {
                profile.Dispose();
                throw;
            }
            finally
            {
                if (stringSid != IntPtr.Zero)
                {
                    NativeMethods.LocalFree(stringSid);
                }
            }

            return profile;
        }

        public void Dispose()
        {
            if (created && !String.IsNullOrEmpty(Name))
            {
                NativeMethods.DeleteAppContainerProfile(Name);
                created = false;
            }

            if (Sid != IntPtr.Zero)
            {
                NativeMethods.FreeSid(Sid);
                Sid = IntPtr.Zero;
            }
        }
    }

    internal static class AclPolicy
    {
        private static readonly FileSystemRights StagingRights = FileSystemRights.ReadAndExecute | FileSystemRights.Write;
        private static readonly FileSystemRights RuntimeRights = FileSystemRights.ReadAndExecute;
        private static readonly FileSystemRights ForbiddenStagingRights =
            FileSystemRights.Delete |
            FileSystemRights.DeleteSubdirectoriesAndFiles |
            FileSystemRights.ChangePermissions |
            FileSystemRights.TakeOwnership;
        private static readonly FileSystemRights ForbiddenRuntimeRights =
            FileSystemRights.Write |
            FileSystemRights.Delete |
            FileSystemRights.DeleteSubdirectoriesAndFiles |
            FileSystemRights.ChangePermissions |
            FileSystemRights.TakeOwnership;

        internal static void PrepareDirectories(TaskManifest manifest)
        {
            RequireStagingOwner(manifest);
            Directory.CreateDirectory(Path.Combine(manifest.StagingRoot, ".knote-tmp"));
            string profileDirectory = Path.Combine(manifest.StagingRoot, ".knote-profile");
            Directory.CreateDirectory(Path.Combine(profileDirectory, "AppData", "Local"));
            Directory.CreateDirectory(Path.Combine(profileDirectory, "AppData", "Roaming"));
        }

        internal static void Apply(TaskManifest manifest, string appContainerSid, Attestation result)
        {
            SecurityIdentifier currentUser = RequireStagingOwner(manifest);

            SecurityIdentifier appSid = new SecurityIdentifier(appContainerSid);
            SetDirectoryAcl(manifest.StagingRoot, currentUser, appSid, StagingRights);
            SetDirectoryAcl(manifest.RuntimeDirectory, currentUser, appSid, RuntimeRights);
            SetFileAcl(manifest.Executable, currentUser, appSid, RuntimeRights);

            result.stagingAcl = HasDirectoryRule(manifest.StagingRoot, appSid, StagingRights, ForbiddenStagingRights);
            result.runtimeAclReadExecute =
                HasDirectoryRule(manifest.RuntimeDirectory, appSid, RuntimeRights, ForbiddenRuntimeRights) &&
                HasFileRule(manifest.Executable, appSid, RuntimeRights, ForbiddenRuntimeRights);

            if (!result.stagingAcl || !result.runtimeAclReadExecute)
            {
                throw new BrokerException("ACL_VERIFICATION_FAILED", "acl", "The AppContainer ACL did not verify after application.");
            }
        }

        private static SecurityIdentifier RequireStagingOwner(TaskManifest manifest)
        {
            SecurityIdentifier currentUser = WindowsIdentity.GetCurrent().User;
            if (currentUser == null)
            {
                throw new BrokerException("STAGING_OWNER_UNKNOWN", "acl", "The broker has no current user SID.");
            }

            DirectorySecurity existing = new DirectoryInfo(manifest.StagingRoot).GetAccessControl(AccessControlSections.Owner);
            SecurityIdentifier owner = existing.GetOwner(typeof(SecurityIdentifier)) as SecurityIdentifier;
            if (owner == null || !owner.Equals(currentUser))
            {
                throw new BrokerException("STAGING_OWNER_INVALID", "acl", "stagingRoot must be owned by the broker user.");
            }
            return currentUser;
        }

        private static void SetDirectoryAcl(
            string path,
            SecurityIdentifier currentUser,
            SecurityIdentifier appSid,
            FileSystemRights appRights)
        {
            DirectorySecurity security = new DirectorySecurity();
            security.SetAccessRuleProtection(true, false);
            AddHostDirectoryRules(security, currentUser);
            security.AddAccessRule(new FileSystemAccessRule(
                appSid,
                appRights,
                InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit,
                PropagationFlags.None,
                AccessControlType.Allow));
            new DirectoryInfo(path).SetAccessControl(security);
        }

        private static void SetFileAcl(
            string path,
            SecurityIdentifier currentUser,
            SecurityIdentifier appSid,
            FileSystemRights appRights)
        {
            FileSecurity security = new FileSecurity();
            security.SetAccessRuleProtection(true, false);
            AddHostFileRules(security, currentUser);
            security.AddAccessRule(new FileSystemAccessRule(appSid, appRights, AccessControlType.Allow));
            new FileInfo(path).SetAccessControl(security);
        }

        private static void AddHostDirectoryRules(DirectorySecurity security, SecurityIdentifier currentUser)
        {
            InheritanceFlags inheritance = InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit;
            security.AddAccessRule(new FileSystemAccessRule(currentUser, FileSystemRights.FullControl, inheritance, PropagationFlags.None, AccessControlType.Allow));
            security.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null), FileSystemRights.FullControl, inheritance, PropagationFlags.None, AccessControlType.Allow));
            security.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null), FileSystemRights.FullControl, inheritance, PropagationFlags.None, AccessControlType.Allow));
        }

        private static void AddHostFileRules(FileSecurity security, SecurityIdentifier currentUser)
        {
            security.AddAccessRule(new FileSystemAccessRule(currentUser, FileSystemRights.FullControl, AccessControlType.Allow));
            security.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null), FileSystemRights.FullControl, AccessControlType.Allow));
            security.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null), FileSystemRights.FullControl, AccessControlType.Allow));
        }

        private static bool HasDirectoryRule(
            string path,
            SecurityIdentifier sid,
            FileSystemRights required,
            FileSystemRights forbidden)
        {
            DirectorySecurity security = new DirectoryInfo(path).GetAccessControl(AccessControlSections.Access);
            return HasRule(security.GetAccessRules(true, true, typeof(SecurityIdentifier)), sid, required, forbidden);
        }

        private static bool HasFileRule(
            string path,
            SecurityIdentifier sid,
            FileSystemRights required,
            FileSystemRights forbidden)
        {
            FileSecurity security = new FileInfo(path).GetAccessControl(AccessControlSections.Access);
            return HasRule(security.GetAccessRules(true, true, typeof(SecurityIdentifier)), sid, required, forbidden);
        }

        private static bool HasRule(
            AuthorizationRuleCollection rules,
            SecurityIdentifier sid,
            FileSystemRights required,
            FileSystemRights forbidden)
        {
            bool hasRequired = false;
            for (int index = 0; index < rules.Count; index++)
            {
                FileSystemAccessRule rule = rules[index] as FileSystemAccessRule;
                if (rule == null || rule.AccessControlType != AccessControlType.Allow || !sid.Equals(rule.IdentityReference))
                {
                    continue;
                }

                if ((rule.FileSystemRights & forbidden) != 0)
                {
                    return false;
                }

                if ((rule.FileSystemRights & required) == required)
                {
                    hasRequired = true;
                }
            }

            return hasRequired;
        }
    }

    internal sealed class ProcThreadAttributes : IDisposable
    {
        internal IntPtr Pointer { get; private set; }
        private readonly List<IntPtr> allocations = new List<IntPtr>();

        internal ProcThreadAttributes(int count)
        {
            IntPtr size = IntPtr.Zero;
            NativeMethods.InitializeProcThreadAttributeList(IntPtr.Zero, count, 0, ref size);
            int firstError = Marshal.GetLastWin32Error();
            if (size == IntPtr.Zero)
            {
                throw SandboxRunner.Win32Failure(
                    "ATTRIBUTE_LIST_SIZE_FAILED",
                    "InitializeProcThreadAttributeList",
                    firstError,
                    "POLICY_REJECTED");
            }

            Pointer = Marshal.AllocHGlobal(size);
            if (!NativeMethods.InitializeProcThreadAttributeList(Pointer, count, 0, ref size))
            {
                int error = Marshal.GetLastWin32Error();
                Dispose();
                throw SandboxRunner.Win32Failure(
                    "ATTRIBUTE_LIST_CREATE_FAILED",
                    "InitializeProcThreadAttributeList",
                    error,
                    "POLICY_REJECTED");
            }
        }

        internal void AddSecurityCapabilities(IntPtr appContainerSid)
        {
            NativeMethods.SECURITY_CAPABILITIES capabilities = new NativeMethods.SECURITY_CAPABILITIES
            {
                AppContainerSid = appContainerSid,
                Capabilities = IntPtr.Zero,
                CapabilityCount = 0,
                Reserved = 0
            };
            IntPtr value = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(NativeMethods.SECURITY_CAPABILITIES)));
            allocations.Add(value);
            Marshal.StructureToPtr(capabilities, value, false);

            if (!NativeMethods.UpdateProcThreadAttribute(
                Pointer,
                0,
                NativeMethods.PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES,
                value,
                new IntPtr(Marshal.SizeOf(typeof(NativeMethods.SECURITY_CAPABILITIES))),
                IntPtr.Zero,
                IntPtr.Zero))
            {
                int error = Marshal.GetLastWin32Error();
                throw SandboxRunner.Win32Failure(
                    "SECURITY_CAPABILITIES_ATTRIBUTE_FAILED",
                    "UpdateProcThreadAttribute",
                    error,
                    "POLICY_REJECTED");
            }
        }

        internal void AddHandleList(IntPtr[] handles)
        {
            IntPtr value = Marshal.AllocHGlobal(IntPtr.Size * handles.Length);
            allocations.Add(value);
            for (int index = 0; index < handles.Length; index++)
            {
                Marshal.WriteIntPtr(value, index * IntPtr.Size, handles[index]);
            }

            if (!NativeMethods.UpdateProcThreadAttribute(
                Pointer,
                0,
                NativeMethods.PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
                value,
                new IntPtr(IntPtr.Size * handles.Length),
                IntPtr.Zero,
                IntPtr.Zero))
            {
                int error = Marshal.GetLastWin32Error();
                throw SandboxRunner.Win32Failure(
                    "HANDLE_ALLOWLIST_ATTRIBUTE_FAILED",
                    "UpdateProcThreadAttribute",
                    error,
                    "POLICY_REJECTED");
            }
        }

        internal void AddJobList(IntPtr job)
        {
            IntPtr value = Marshal.AllocHGlobal(IntPtr.Size);
            allocations.Add(value);
            Marshal.WriteIntPtr(value, job);

            if (!NativeMethods.UpdateProcThreadAttribute(
                Pointer,
                0,
                NativeMethods.PROC_THREAD_ATTRIBUTE_JOB_LIST,
                value,
                new IntPtr(IntPtr.Size),
                IntPtr.Zero,
                IntPtr.Zero))
            {
                int error = Marshal.GetLastWin32Error();
                throw SandboxRunner.Win32Failure(
                    "JOB_LIST_ATTRIBUTE_FAILED",
                    "UpdateProcThreadAttribute",
                    error,
                    "POLICY_REJECTED");
            }
        }

        public void Dispose()
        {
            if (Pointer != IntPtr.Zero)
            {
                NativeMethods.DeleteProcThreadAttributeList(Pointer);
                Marshal.FreeHGlobal(Pointer);
                Pointer = IntPtr.Zero;
            }

            for (int index = 0; index < allocations.Count; index++)
            {
                Marshal.FreeHGlobal(allocations[index]);
            }
            allocations.Clear();
        }
    }

    internal sealed class CaptureBudget : IDisposable
    {
        private readonly object sync = new object();
        private readonly long limit;
        private long consumed;
        private bool exceeded;
        internal ManualResetEvent LimitEvent { get; private set; }

        internal CaptureBudget(long limit)
        {
            this.limit = limit;
            LimitEvent = new ManualResetEvent(false);
        }

        internal int Reserve(int requested)
        {
            lock (sync)
            {
                long remaining = limit - consumed;
                int accepted = remaining <= 0 ? 0 : (int)Math.Min((long)requested, remaining);
                consumed += accepted;
                if (accepted < requested)
                {
                    exceeded = true;
                    LimitEvent.Set();
                }
                return accepted;
            }
        }

        internal bool Exceeded
        {
            get
            {
                lock (sync)
                {
                    return exceeded;
                }
            }
        }

        public void Dispose()
        {
            LimitEvent.Dispose();
        }
    }

    internal sealed class PipeReader : IDisposable
    {
        private readonly SafeFileHandle handle;
        private readonly CaptureBudget budget;
        private readonly MemoryStream captured = new MemoryStream();
        private readonly ManualResetEvent completed = new ManualResetEvent(false);
        private Thread thread;

        internal PipeReader(IntPtr readHandle, CaptureBudget budget, string name)
        {
            this.handle = new SafeFileHandle(readHandle, true);
            this.budget = budget;
            thread = new Thread(ReadLoop);
            thread.Name = name;
            thread.IsBackground = true;
        }

        internal void Start()
        {
            thread.Start();
        }

        private void ReadLoop()
        {
            try
            {
                using (FileStream stream = new FileStream(handle, FileAccess.Read, 4096, false))
                {
                    byte[] buffer = new byte[4096];
                    while (true)
                    {
                        int read = stream.Read(buffer, 0, buffer.Length);
                        if (read == 0)
                        {
                            break;
                        }

                        int accepted = budget.Reserve(read);
                        if (accepted > 0)
                        {
                            captured.Write(buffer, 0, accepted);
                        }
                    }
                }
            }
            catch (IOException)
            {
            }
            catch (ObjectDisposedException)
            {
            }
            finally
            {
                completed.Set();
            }
        }

        internal void WaitForCompletion()
        {
            if (!completed.WaitOne(5000))
            {
                handle.Dispose();
                completed.WaitOne(1000);
            }
        }

        internal long Length
        {
            get { return captured.Length; }
        }

        internal string GetText()
        {
            return new UTF8Encoding(false, false).GetString(captured.ToArray());
        }

        public void Dispose()
        {
            handle.Dispose();
            completed.Dispose();
            captured.Dispose();
        }
    }

    internal sealed class PipeSet : IDisposable
    {
        internal IntPtr ChildStdinRead;
        internal IntPtr ParentStdinWrite;
        internal IntPtr ParentStdoutRead;
        internal IntPtr ChildStdoutWrite;
        internal IntPtr ParentStderrRead;
        internal IntPtr ChildStderrWrite;
        internal PipeReader StdoutReader;
        internal PipeReader StderrReader;

        internal static PipeSet Create()
        {
            PipeSet pipes = new PipeSet();
            NativeMethods.SECURITY_ATTRIBUTES attributes = new NativeMethods.SECURITY_ATTRIBUTES
            {
                nLength = Marshal.SizeOf(typeof(NativeMethods.SECURITY_ATTRIBUTES)),
                lpSecurityDescriptor = IntPtr.Zero,
                bInheritHandle = 1
            };

            try
            {
                CreatePipe(ref attributes, out pipes.ChildStdinRead, out pipes.ParentStdinWrite);
                CreatePipe(ref attributes, out pipes.ParentStdoutRead, out pipes.ChildStdoutWrite);
                CreatePipe(ref attributes, out pipes.ParentStderrRead, out pipes.ChildStderrWrite);

                MakeNonInheritable(pipes.ParentStdinWrite);
                MakeNonInheritable(pipes.ParentStdoutRead);
                MakeNonInheritable(pipes.ParentStderrRead);
                return pipes;
            }
            catch
            {
                pipes.Dispose();
                throw;
            }
        }

        private static void CreatePipe(
            ref NativeMethods.SECURITY_ATTRIBUTES attributes,
            out IntPtr readHandle,
            out IntPtr writeHandle)
        {
            if (!NativeMethods.CreatePipe(out readHandle, out writeHandle, ref attributes, 0))
            {
                int error = Marshal.GetLastWin32Error();
                throw SandboxRunner.Win32Failure("PIPE_CREATE_FAILED", "CreatePipe", error, "POLICY_REJECTED");
            }
        }

        private static void MakeNonInheritable(IntPtr handle)
        {
            if (!NativeMethods.SetHandleInformation(handle, NativeMethods.HANDLE_FLAG_INHERIT, 0))
            {
                int error = Marshal.GetLastWin32Error();
                throw SandboxRunner.Win32Failure(
                    "PIPE_INHERITANCE_FAILED",
                    "SetHandleInformation",
                    error,
                    "POLICY_REJECTED");
            }
        }

        internal IntPtr[] InheritedHandles
        {
            get { return new[] { ChildStdinRead, ChildStdoutWrite, ChildStderrWrite }; }
        }

        internal void ReleaseChildEndsAndCloseStdin()
        {
            Close(ref ChildStdinRead);
            Close(ref ChildStdoutWrite);
            Close(ref ChildStderrWrite);
            Close(ref ParentStdinWrite);
        }

        internal void StartReaders(CaptureBudget budget)
        {
            StdoutReader = new PipeReader(ParentStdoutRead, budget, "Knote stdout reader");
            ParentStdoutRead = IntPtr.Zero;
            StderrReader = new PipeReader(ParentStderrRead, budget, "Knote stderr reader");
            ParentStderrRead = IntPtr.Zero;
            StdoutReader.Start();
            StderrReader.Start();
        }

        internal void Complete(Attestation result)
        {
            if (StdoutReader != null)
            {
                StdoutReader.WaitForCompletion();
                result.stdout = StdoutReader.GetText();
                result.stdoutCapturedBytes = StdoutReader.Length;
            }
            if (StderrReader != null)
            {
                StderrReader.WaitForCompletion();
                result.stderr = StderrReader.GetText();
                result.stderrCapturedBytes = StderrReader.Length;
            }
        }

        private static void Close(ref IntPtr handle)
        {
            if (handle != IntPtr.Zero)
            {
                NativeMethods.CloseHandle(handle);
                handle = IntPtr.Zero;
            }
        }

        public void Dispose()
        {
            Close(ref ChildStdinRead);
            Close(ref ParentStdinWrite);
            Close(ref ParentStdoutRead);
            Close(ref ChildStdoutWrite);
            Close(ref ParentStderrRead);
            Close(ref ChildStderrWrite);
            if (StdoutReader != null)
            {
                StdoutReader.Dispose();
                StdoutReader = null;
            }
            if (StderrReader != null)
            {
                StderrReader.Dispose();
                StderrReader = null;
            }
        }
    }

    internal static class SandboxRunner
    {
        internal static Attestation Run(TaskManifest manifest)
        {
            Attestation result = Attestation.Create(manifest.TaskId);
            result.outputBudgetBytes = manifest.StdoutBytes;

            AppContainerProfile profile = null;
            ProcThreadAttributes attributes = null;
            PipeSet pipes = null;
            CaptureBudget budget = null;
            PinnedStagingTree pinnedStaging = null;
            IntPtr environment = IntPtr.Zero;
            IntPtr job = IntPtr.Zero;
            NativeMethods.PROCESS_INFORMATION process = new NativeMethods.PROCESS_INFORMATION();
            bool processCreated = false;
            bool processResumed = false;
            Stopwatch duration = new Stopwatch();

            try
            {
                pinnedStaging = PinnedStagingTree.Create(manifest);
                AclPolicy.PrepareDirectories(manifest);
                pinnedStaging.PinCurrentTree(manifest);
                result.stagingHandlesPinned = true;

                profile = AppContainerProfile.Create();
                result.appContainerSid = profile.SidString;

                AclPolicy.Apply(manifest, profile.SidString, result);

                bool loopbackExempt;
                VerifyNoLoopbackExemption(profile.Sid, out loopbackExempt);
                result.loopbackExempt = loopbackExempt;
                if (loopbackExempt)
                {
                    throw new BrokerException(
                        "LOOPBACK_EXEMPTION_PRESENT",
                        "NetworkIsolationGetAppContainerConfig",
                        "The unique AppContainer SID unexpectedly has a loopback exemption.");
                }

                job = CreateConfiguredJob(manifest, result);
                pipes = PipeSet.Create();
                attributes = new ProcThreadAttributes(3);
                attributes.AddSecurityCapabilities(profile.Sid);
                attributes.AddHandleList(pipes.InheritedHandles);
                attributes.AddJobList(job);
                environment = BuildEnvironment(manifest);

                NativeMethods.STARTUPINFOEX startup = new NativeMethods.STARTUPINFOEX();
                startup.StartupInfo.cb = Marshal.SizeOf(typeof(NativeMethods.STARTUPINFOEX));
                startup.StartupInfo.dwFlags = NativeMethods.STARTF_USESTDHANDLES;
                startup.StartupInfo.hStdInput = pipes.ChildStdinRead;
                startup.StartupInfo.hStdOutput = pipes.ChildStdoutWrite;
                startup.StartupInfo.hStdError = pipes.ChildStderrWrite;
                startup.lpAttributeList = attributes.Pointer;

                StringBuilder commandLine = new StringBuilder(CommandLineBuilder.Build(manifest.Executable, manifest.Argv));
                uint creationFlags =
                    NativeMethods.CREATE_SUSPENDED |
                    NativeMethods.CREATE_UNICODE_ENVIRONMENT |
                    NativeMethods.EXTENDED_STARTUPINFO_PRESENT |
                    NativeMethods.CREATE_NO_WINDOW;

                pinnedStaging.RevalidateCritical(manifest);
                result.executableIdentityVerified = true;

                if (!NativeMethods.CreateProcessW(
                    manifest.Executable,
                    commandLine,
                    IntPtr.Zero,
                    IntPtr.Zero,
                    true,
                    creationFlags,
                    environment,
                    manifest.Cwd,
                    ref startup,
                    out process))
                {
                    int error = Marshal.GetLastWin32Error();
                    throw RuntimeLaunchFailure(error);
                }
                processCreated = true;
                pipes.ReleaseChildEndsAndCloseStdin();

                IntPtr token = IntPtr.Zero;
                try
                {
                    if (!NativeMethods.OpenProcessToken(process.hProcess, NativeMethods.TOKEN_QUERY, out token))
                    {
                        int error = Marshal.GetLastWin32Error();
                        throw Win32Failure("TOKEN_QUERY_FAILED", "OpenProcessToken", error, "POLICY_REJECTED");
                    }

                    result.tokenIsAppContainer = QueryTokenInt(token, NativeMethods.TokenIsAppContainer) != 0;
                    result.capabilityCount = QueryTokenCapabilityCount(token);
                    result.appContainerSidVerified = QueryAndCompareAppContainerSid(token, profile.Sid);
                }
                finally
                {
                    if (token != IntPtr.Zero)
                    {
                        NativeMethods.CloseHandle(token);
                    }
                }

                result.networkCapabilities = result.capabilityCount == 0 ? "none" : "present";
                if (!result.tokenIsAppContainer || !result.appContainerSidVerified || result.capabilityCount != 0)
                {
                    throw new BrokerException(
                        "APPCONTAINER_TOKEN_VERIFICATION_FAILED",
                        "GetTokenInformation",
                        "The suspended child did not have the expected zero-capability AppContainer token.");
                }

                bool inJob;
                if (!NativeMethods.IsProcessInJob(process.hProcess, job, out inJob))
                {
                    int error = Marshal.GetLastWin32Error();
                    throw Win32Failure("JOB_VERIFY_FAILED", "IsProcessInJob", error, "POLICY_REJECTED");
                }
                result.jobAssigned = inJob;
                result.jobAssignment = inJob ? "creation_attribute" : "unknown";
                if (!inJob)
                {
                    throw new BrokerException("JOB_VERIFY_FAILED", "IsProcessInJob", "The child was not assigned to the configured Job Object.");
                }

                budget = new CaptureBudget(manifest.StdoutBytes);
                pipes.StartReaders(budget);

                duration.Start();
                uint resumeResult = NativeMethods.ResumeThread(process.hThread);
                if (resumeResult == 0xffffffff)
                {
                    int error = Marshal.GetLastWin32Error();
                    throw Win32Failure("THREAD_RESUME_FAILED", "ResumeThread", error, "LAUNCH_FAILED");
                }
                processResumed = true;
                NativeMethods.CloseHandle(process.hThread);
                process.hThread = IntPtr.Zero;

                result.isolationEnforced =
                    result.tokenIsAppContainer &&
                    result.appContainerSidVerified &&
                    result.jobAssigned &&
                    result.jobLimitsVerified &&
                    result.stagingAcl &&
                    result.runtimeAclReadExecute &&
                    result.stagingHandlesPinned &&
                    result.executableIdentityVerified &&
                    result.capabilityCount == 0 &&
                    result.loopbackExempt == false;

                if (!result.isolationEnforced)
                {
                    throw new BrokerException("ISOLATION_ATTESTATION_FAILED", "attestation", "Required isolation evidence was not true.");
                }

                result.termination = WaitForTermination(process.hProcess, job, manifest.TimeoutMs, budget);
                QueryJobPeaks(job, result);
                CloseJob(ref job);
                NativeMethods.WaitForSingleObject(process.hProcess, NativeMethods.INFINITE);
                duration.Stop();
                result.durationMs = duration.ElapsedMilliseconds;

                uint exitCode;
                if (NativeMethods.GetExitCodeProcess(process.hProcess, out exitCode) && exitCode != NativeMethods.STILL_ACTIVE)
                {
                    result.exitCode = exitCode;
                }

                pipes.Complete(result);
                if (budget.Exceeded)
                {
                    result.termination = "OUTPUT_LIMIT";
                }

                if (result.termination == "OUTPUT_LIMIT")
                {
                    result.error = new ErrorAttestation
                    {
                        code = "OUTPUT_LIMIT",
                        stage = "capture",
                        nativeError = null,
                        message = "Combined stdout/stderr exceeded stdoutBytes; the Job was closed."
                    };
                }
                else if (result.termination == "TIMEOUT")
                {
                    result.error = new ErrorAttestation
                    {
                        code = "TIMEOUT",
                        stage = "wait",
                        nativeError = null,
                        message = "timeoutMs elapsed; the Job was closed."
                    };
                }
            }
            catch (BrokerException exception)
            {
                if (duration.IsRunning)
                {
                    duration.Stop();
                    result.durationMs = duration.ElapsedMilliseconds;
                }

                result.termination = exception.Termination;
                result.error = ToAttestation(exception);
                if (!processResumed)
                {
                    result.isolationEnforced = false;
                }
            }
            catch (Exception exception)
            {
                if (duration.IsRunning)
                {
                    duration.Stop();
                    result.durationMs = duration.ElapsedMilliseconds;
                }

                result.isolationEnforced = false;
                result.termination = "INTERNAL_ERROR";
                result.error = new ErrorAttestation
                {
                    code = "BROKER_INTERNAL_ERROR",
                    stage = "broker",
                    nativeError = null,
                    message = exception.GetType().Name + ": " + exception.Message
                };
            }
            finally
            {
                if (processCreated && !processResumed && process.hProcess != IntPtr.Zero)
                {
                    NativeMethods.TerminateProcess(process.hProcess, 0xc0000022);
                }

                CloseJob(ref job);

                if (process.hThread != IntPtr.Zero)
                {
                    NativeMethods.CloseHandle(process.hThread);
                    process.hThread = IntPtr.Zero;
                }

                if (process.hProcess != IntPtr.Zero)
                {
                    NativeMethods.WaitForSingleObject(process.hProcess, NativeMethods.INFINITE);
                    NativeMethods.CloseHandle(process.hProcess);
                    process.hProcess = IntPtr.Zero;
                }

                if (pipes != null)
                {
                    pipes.ReleaseChildEndsAndCloseStdin();
                    pipes.Complete(result);
                    pipes.Dispose();
                }
                if (budget != null)
                {
                    budget.Dispose();
                }
                if (attributes != null)
                {
                    attributes.Dispose();
                }
                if (environment != IntPtr.Zero)
                {
                    Marshal.FreeHGlobal(environment);
                }
                if (profile != null)
                {
                    profile.Dispose();
                }
                if (pinnedStaging != null)
                {
                    pinnedStaging.Dispose();
                }
            }

            return result;
        }

        private static string WaitForTermination(
            IntPtr process,
            IntPtr job,
            int timeoutMs,
            CaptureBudget budget)
        {
            Stopwatch wait = Stopwatch.StartNew();
            while (true)
            {
                if (budget.LimitEvent.WaitOne(0))
                {
                    return "OUTPUT_LIMIT";
                }

                uint waitResult = NativeMethods.WaitForSingleObject(process, 10);
                if (waitResult == NativeMethods.WAIT_OBJECT_0)
                {
                    return "EXITED";
                }
                if (waitResult == NativeMethods.WAIT_FAILED)
                {
                    int error = Marshal.GetLastWin32Error();
                    throw Win32Failure("PROCESS_WAIT_FAILED", "WaitForSingleObject", error, "INTERNAL_ERROR");
                }
                if (wait.ElapsedMilliseconds >= timeoutMs)
                {
                    return "TIMEOUT";
                }
            }
        }

        private static IntPtr CreateConfiguredJob(TaskManifest manifest, Attestation result)
        {
            IntPtr job = NativeMethods.CreateJobObjectW(IntPtr.Zero, null);
            if (job == IntPtr.Zero)
            {
                int error = Marshal.GetLastWin32Error();
                throw Win32Failure("JOB_CREATE_FAILED", "CreateJobObjectW", error, "POLICY_REJECTED");
            }

            IntPtr informationPointer = IntPtr.Zero;
            try
            {
                NativeMethods.JOBOBJECT_EXTENDED_LIMIT_INFORMATION information =
                    new NativeMethods.JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
                information.BasicLimitInformation.LimitFlags =
                    NativeMethods.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE |
                    NativeMethods.JOB_OBJECT_LIMIT_ACTIVE_PROCESS |
                    NativeMethods.JOB_OBJECT_LIMIT_PROCESS_MEMORY |
                    NativeMethods.JOB_OBJECT_LIMIT_JOB_MEMORY;
                information.BasicLimitInformation.ActiveProcessLimit = (uint)manifest.ProcessCount;
                information.ProcessMemoryLimit = new UIntPtr((ulong)manifest.MemoryBytes);
                information.JobMemoryLimit = new UIntPtr((ulong)manifest.MemoryBytes);

                int size = Marshal.SizeOf(typeof(NativeMethods.JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
                informationPointer = Marshal.AllocHGlobal(size);
                Marshal.StructureToPtr(information, informationPointer, false);
                if (!NativeMethods.SetInformationJobObject(
                    job,
                    NativeMethods.JobObjectExtendedLimitInformation,
                    informationPointer,
                    (uint)size))
                {
                    int error = Marshal.GetLastWin32Error();
                    throw Win32Failure("JOB_LIMITS_FAILED", "SetInformationJobObject", error, "POLICY_REJECTED");
                }

                if (!NativeMethods.QueryInformationJobObject(
                    job,
                    NativeMethods.JobObjectExtendedLimitInformation,
                    informationPointer,
                    (uint)size,
                    IntPtr.Zero))
                {
                    int error = Marshal.GetLastWin32Error();
                    throw Win32Failure("JOB_LIMITS_QUERY_FAILED", "QueryInformationJobObject", error, "POLICY_REJECTED");
                }

                NativeMethods.JOBOBJECT_EXTENDED_LIMIT_INFORMATION queried =
                    (NativeMethods.JOBOBJECT_EXTENDED_LIMIT_INFORMATION)Marshal.PtrToStructure(
                        informationPointer,
                        typeof(NativeMethods.JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
                uint requiredFlags =
                    NativeMethods.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE |
                    NativeMethods.JOB_OBJECT_LIMIT_ACTIVE_PROCESS |
                    NativeMethods.JOB_OBJECT_LIMIT_PROCESS_MEMORY |
                    NativeMethods.JOB_OBJECT_LIMIT_JOB_MEMORY;
                uint breakawayFlags =
                    NativeMethods.JOB_OBJECT_LIMIT_BREAKAWAY_OK |
                    NativeMethods.JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK;
                result.breakawayAllowed = (queried.BasicLimitInformation.LimitFlags & breakawayFlags) != 0;
                result.jobLimitsVerified =
                    (queried.BasicLimitInformation.LimitFlags & requiredFlags) == requiredFlags &&
                    !result.breakawayAllowed &&
                    queried.BasicLimitInformation.ActiveProcessLimit == (uint)manifest.ProcessCount &&
                    queried.ProcessMemoryLimit.ToUInt64() == (ulong)manifest.MemoryBytes &&
                    queried.JobMemoryLimit.ToUInt64() == (ulong)manifest.MemoryBytes;
                if (!result.jobLimitsVerified)
                {
                    throw new BrokerException(
                        "JOB_LIMITS_VERIFICATION_FAILED",
                        "QueryInformationJobObject",
                        "The Job limits did not match the requested fail-closed policy.");
                }

                return job;
            }
            catch
            {
                NativeMethods.CloseHandle(job);
                throw;
            }
            finally
            {
                if (informationPointer != IntPtr.Zero)
                {
                    Marshal.FreeHGlobal(informationPointer);
                }
            }
        }

        private static void QueryJobPeaks(IntPtr job, Attestation result)
        {
            if (job == IntPtr.Zero)
            {
                return;
            }

            int size = Marshal.SizeOf(typeof(NativeMethods.JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
            IntPtr pointer = Marshal.AllocHGlobal(size);
            try
            {
                if (!NativeMethods.QueryInformationJobObject(
                    job,
                    NativeMethods.JobObjectExtendedLimitInformation,
                    pointer,
                    (uint)size,
                    IntPtr.Zero))
                {
                    return;
                }

                NativeMethods.JOBOBJECT_EXTENDED_LIMIT_INFORMATION information =
                    (NativeMethods.JOBOBJECT_EXTENDED_LIMIT_INFORMATION)Marshal.PtrToStructure(
                        pointer,
                        typeof(NativeMethods.JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
                result.peakProcessMemoryBytes = ToLong(information.PeakProcessMemoryUsed);
                result.peakJobMemoryBytes = ToLong(information.PeakJobMemoryUsed);
            }
            finally
            {
                Marshal.FreeHGlobal(pointer);
            }
        }

        private static long ToLong(UIntPtr value)
        {
            ulong raw = value.ToUInt64();
            return raw > Int64.MaxValue ? Int64.MaxValue : (long)raw;
        }

        private static void CloseJob(ref IntPtr job)
        {
            if (job != IntPtr.Zero)
            {
                NativeMethods.CloseHandle(job);
                job = IntPtr.Zero;
            }
        }

        private static IntPtr BuildEnvironment(TaskManifest manifest)
        {
            string systemRoot = Environment.GetFolderPath(Environment.SpecialFolder.Windows);
            if (String.IsNullOrEmpty(systemRoot))
            {
                systemRoot = @"C:\Windows";
            }

            string temporaryDirectory = Path.Combine(manifest.StagingRoot, ".knote-tmp");
            string profileDirectory = Path.Combine(manifest.StagingRoot, ".knote-profile");
            string driveRoot = Path.GetPathRoot(manifest.Cwd);
            string driveName = driveRoot.Substring(0, 2);
            string systemDrive = Path.GetPathRoot(systemRoot).Substring(0, 2);
            string programData = Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData);
            string programFiles = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
            string programFilesX86 = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86);
            SortedDictionary<string, string> variables = new SortedDictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            variables["=" + driveName] = manifest.Cwd;
            variables["ALLUSERSPROFILE"] = programData;
            variables["APPDATA"] = Path.Combine(profileDirectory, "AppData", "Roaming");
            variables["COMSPEC"] = Path.Combine(systemRoot, "System32", "cmd.exe");
            variables["HOMEDRIVE"] = driveName;
            variables["HOMEPATH"] = profileDirectory.Substring(2);
            variables["LOCALAPPDATA"] = Path.Combine(profileDirectory, "AppData", "Local");
            variables["NUMBER_OF_PROCESSORS"] = Environment.ProcessorCount.ToString();
            variables["OS"] = "Windows_NT";
            variables["PATH"] = manifest.RuntimeDirectory + ";" + Path.Combine(systemRoot, "System32");
            variables["PATHEXT"] = ".COM;.EXE;.BAT;.CMD";
            variables["PROCESSOR_ARCHITECTURE"] = "AMD64";
            variables["ProgramData"] = programData;
            variables["ProgramFiles"] = programFiles;
            variables["ProgramFiles(x86)"] = programFilesX86;
            variables["ProgramW6432"] = programFiles;
            variables["PUBLIC"] = Path.Combine(systemDrive + "\\", "Users", "Public");
            variables["SystemDrive"] = systemDrive;
            variables["SystemRoot"] = systemRoot;
            variables["TEMP"] = temporaryDirectory;
            variables["TMP"] = temporaryDirectory;
            variables["USERNAME"] = "KnoteSandbox";
            variables["USERPROFILE"] = profileDirectory;
            variables["WINDIR"] = systemRoot;

            StringBuilder block = new StringBuilder();
            foreach (KeyValuePair<string, string> variable in variables)
            {
                block.Append(variable.Key);
                block.Append('=');
                block.Append(variable.Value);
                block.Append('\0');
            }
            block.Append('\0');
            return Marshal.StringToHGlobalUni(block.ToString());
        }

        private static int QueryTokenInt(IntPtr token, int informationClass)
        {
            IntPtr buffer = Marshal.AllocHGlobal(sizeof(int));
            try
            {
                int returned;
                if (!NativeMethods.GetTokenInformation(token, informationClass, buffer, sizeof(int), out returned))
                {
                    int error = Marshal.GetLastWin32Error();
                    throw Win32Failure("TOKEN_QUERY_FAILED", "GetTokenInformation", error, "POLICY_REJECTED");
                }
                return Marshal.ReadInt32(buffer);
            }
            finally
            {
                Marshal.FreeHGlobal(buffer);
            }
        }

        private static int QueryTokenCapabilityCount(IntPtr token)
        {
            int required;
            NativeMethods.GetTokenInformation(token, NativeMethods.TokenCapabilities, IntPtr.Zero, 0, out required);
            int firstError = Marshal.GetLastWin32Error();
            if (required <= 0 || (firstError != (int)NativeMethods.ERROR_INSUFFICIENT_BUFFER && firstError != 0))
            {
                throw Win32Failure("TOKEN_CAPABILITIES_QUERY_FAILED", "GetTokenInformation", firstError, "POLICY_REJECTED");
            }

            IntPtr buffer = Marshal.AllocHGlobal(required);
            try
            {
                if (!NativeMethods.GetTokenInformation(
                    token,
                    NativeMethods.TokenCapabilities,
                    buffer,
                    required,
                    out required))
                {
                    int error = Marshal.GetLastWin32Error();
                    throw Win32Failure("TOKEN_CAPABILITIES_QUERY_FAILED", "GetTokenInformation", error, "POLICY_REJECTED");
                }
                return Marshal.ReadInt32(buffer);
            }
            finally
            {
                Marshal.FreeHGlobal(buffer);
            }
        }

        private static bool QueryAndCompareAppContainerSid(IntPtr token, IntPtr expectedSid)
        {
            int required;
            NativeMethods.GetTokenInformation(token, NativeMethods.TokenAppContainerSid, IntPtr.Zero, 0, out required);
            int firstError = Marshal.GetLastWin32Error();
            if (required <= 0 || (firstError != (int)NativeMethods.ERROR_INSUFFICIENT_BUFFER && firstError != 0))
            {
                throw Win32Failure("TOKEN_SID_QUERY_FAILED", "GetTokenInformation", firstError, "POLICY_REJECTED");
            }

            IntPtr buffer = Marshal.AllocHGlobal(required);
            try
            {
                if (!NativeMethods.GetTokenInformation(
                    token,
                    NativeMethods.TokenAppContainerSid,
                    buffer,
                    required,
                    out required))
                {
                    int error = Marshal.GetLastWin32Error();
                    throw Win32Failure("TOKEN_SID_QUERY_FAILED", "GetTokenInformation", error, "POLICY_REJECTED");
                }

                IntPtr actualSid = Marshal.ReadIntPtr(buffer);
                return actualSid != IntPtr.Zero && NativeMethods.EqualSid(actualSid, expectedSid);
            }
            finally
            {
                Marshal.FreeHGlobal(buffer);
            }
        }

        private static void VerifyNoLoopbackExemption(IntPtr expectedSid, out bool exempt)
        {
            uint count;
            IntPtr entries;
            uint error = NativeMethods.NetworkIsolationGetAppContainerConfig(out count, out entries);
            if (error != 0)
            {
                throw Win32Failure(
                    "LOOPBACK_CONFIG_QUERY_FAILED",
                    "NetworkIsolationGetAppContainerConfig",
                    unchecked((int)error),
                    "POLICY_REJECTED");
            }

            exempt = false;
            try
            {
                int size = Marshal.SizeOf(typeof(NativeMethods.SID_AND_ATTRIBUTES));
                for (uint index = 0; index < count; index++)
                {
                    IntPtr current = new IntPtr(entries.ToInt64() + ((long)index * size));
                    NativeMethods.SID_AND_ATTRIBUTES item =
                        (NativeMethods.SID_AND_ATTRIBUTES)Marshal.PtrToStructure(
                            current,
                            typeof(NativeMethods.SID_AND_ATTRIBUTES));
                    if (item.Sid != IntPtr.Zero && NativeMethods.EqualSid(item.Sid, expectedSid))
                    {
                        exempt = true;
                        return;
                    }
                }
            }
            finally
            {
                if (entries != IntPtr.Zero)
                {
                    IntPtr processHeap = NativeMethods.GetProcessHeap();
                    int size = Marshal.SizeOf(typeof(NativeMethods.SID_AND_ATTRIBUTES));
                    for (uint index = 0; index < count; index++)
                    {
                        IntPtr current = new IntPtr(entries.ToInt64() + ((long)index * size));
                        NativeMethods.SID_AND_ATTRIBUTES item =
                            (NativeMethods.SID_AND_ATTRIBUTES)Marshal.PtrToStructure(
                                current,
                                typeof(NativeMethods.SID_AND_ATTRIBUTES));
                        if (item.Sid != IntPtr.Zero)
                        {
                            NativeMethods.HeapFree(processHeap, 0, item.Sid);
                        }
                    }
                    NativeMethods.HeapFree(processHeap, 0, entries);
                }
            }
        }

        private static BrokerException RuntimeLaunchFailure(int error)
        {
            string code;
            switch (error)
            {
                case 5:
                    code = "APPCONTAINER_RUNTIME_ACCESS_DENIED";
                    break;
                case 126:
                case 127:
                    code = "APPCONTAINER_RUNTIME_DEPENDENCY_MISSING";
                    break;
                case 193:
                case 216:
                    code = "APPCONTAINER_RUNTIME_IMAGE_INCOMPATIBLE";
                    break;
                case 577:
                    code = "APPCONTAINER_RUNTIME_SIGNATURE_REJECTED";
                    break;
                case 740:
                    code = "APPCONTAINER_RUNTIME_REQUIRES_ELEVATION";
                    break;
                default:
                    code = "APPCONTAINER_RUNTIME_INCOMPATIBLE";
                    break;
            }

            return Win32Failure(code, "CreateProcessW", error, "LAUNCH_FAILED");
        }

        internal static BrokerException Win32Failure(
            string code,
            string stage,
            int error,
            string termination)
        {
            return new BrokerException(
                code,
                stage,
                stage + " failed with Win32 error " + error + ": " + new Win32Exception(error).Message,
                error,
                termination);
        }

        internal static ErrorAttestation ToAttestation(BrokerException exception)
        {
            return new ErrorAttestation
            {
                code = exception.Code,
                stage = exception.Stage,
                nativeError = exception.NativeError,
                message = exception.Message
            };
        }
    }

    internal static class Program
    {
        private static int Main(string[] args)
        {
            Console.SetIn(new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false, true)));
            Console.OutputEncoding = new UTF8Encoding(false, false);

            Attestation result;
            if (args.Length != 0)
            {
                result = Attestation.Create(null);
                result.error = new ErrorAttestation
                {
                    code = "CLI_ARGUMENTS_REJECTED",
                    stage = "cli",
                    nativeError = null,
                    message = "Pass exactly one v1 JSON manifest on stdin; command-line task arguments are not accepted."
                };
            }
            else
            {
                try
                {
                    TaskManifest manifest = ManifestParser.Parse(Console.In);
                    result = SandboxRunner.Run(manifest);
                }
                catch (BrokerException exception)
                {
                    result = Attestation.Create(null);
                    result.termination = exception.Termination;
                    result.error = SandboxRunner.ToAttestation(exception);
                }
                catch (Exception exception)
                {
                    result = Attestation.Create(null);
                    result.termination = "INTERNAL_ERROR";
                    result.error = new ErrorAttestation
                    {
                        code = "BROKER_INTERNAL_ERROR",
                        stage = "broker",
                        nativeError = null,
                        message = exception.GetType().Name + ": " + exception.Message
                    };
                }
            }

            JavaScriptSerializer serializer = new JavaScriptSerializer
            {
                MaxJsonLength = 32 * 1024 * 1024,
                RecursionLimit = 16
            };
            Console.Out.WriteLine(EscapeNonAscii(serializer.Serialize(result)));

            return result.isolationEnforced &&
                   result.termination == "EXITED" &&
                   result.exitCode == 0
                ? 0
                : 1;
        }

        private static string EscapeNonAscii(string json)
        {
            StringBuilder builder = new StringBuilder(json.Length);
            for (int index = 0; index < json.Length; index++)
            {
                char value = json[index];
                if (value <= 0x7f)
                {
                    builder.Append(value);
                }
                else
                {
                    builder.Append("\\u");
                    builder.Append(((int)value).ToString("x4"));
                }
            }
            return builder.ToString();
        }
    }
}
