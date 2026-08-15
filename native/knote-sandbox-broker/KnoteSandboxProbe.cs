using System;
using System.Collections.Generic;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Text;
using System.Web.Script.Serialization;

namespace KnoteSandbox
{
    internal sealed class ProbeResult
    {
        public string probeVersion { get; set; }
        public bool isolationObserved { get; set; }
        public bool tokenIsAppContainer { get; set; }
        public string appContainerSid { get; set; }
        public bool jobAssigned { get; set; }
        public bool stagingRead { get; set; }
        public bool stagingWrite { get; set; }
        public bool hostSentinelDenied { get; set; }
        public string hostSentinelError { get; set; }
        public bool loopbackDenied { get; set; }
        public bool publicNetworkDenied { get; set; }
        public string error { get; set; }
    }

    internal static class ProbeProgram
    {
        private static int Main(string[] args)
        {
            Console.OutputEncoding = new UTF8Encoding(false, false);
            ProbeResult result = new ProbeResult
            {
                probeVersion = "knote.sandbox-probe.v1",
                isolationObserved = false,
                tokenIsAppContainer = false,
                appContainerSid = null,
                jobAssigned = false,
                stagingRead = false,
                stagingWrite = false,
                hostSentinelDenied = false,
                hostSentinelError = null,
                loopbackDenied = false,
                publicNetworkDenied = false,
                error = null
            };

            try
            {
                Dictionary<string, string> options = ParseOptions(args);
                string staging = Path.GetFullPath(options["--staging"]);
                string sentinel = Path.GetFullPath(options["--host-sentinel"]);
                int loopbackPort;
                if (!Int32.TryParse(options["--loopback-port"], out loopbackPort) || loopbackPort < 1 || loopbackPort > 65535)
                {
                    throw new InvalidOperationException("--loopback-port is invalid.");
                }

                QueryToken(result);

                bool inJob;
                if (!NativeMethods.IsProcessInJob(NativeMethods.GetCurrentProcess(), IntPtr.Zero, out inJob))
                {
                    throw new InvalidOperationException("IsProcessInJob failed with " + Marshal.GetLastWin32Error() + ".");
                }
                result.jobAssigned = inJob;

                string inputPath = Path.Combine(staging, "work", "probe-input.txt");
                result.stagingRead = String.Equals(File.ReadAllText(inputPath).Trim(), "probe-input", StringComparison.Ordinal);
                string outputPath = Path.Combine(staging, "work", "probe-output.txt");
                File.WriteAllText(outputPath, "probe-output", new UTF8Encoding(false));
                result.stagingWrite = File.Exists(outputPath);

                try
                {
                    File.ReadAllText(sentinel);
                    result.hostSentinelDenied = false;
                }
                catch (Exception exception)
                {
                    result.hostSentinelDenied = true;
                    result.hostSentinelError = exception.GetType().Name + ": " + exception.Message;
                }

                result.loopbackDenied = !CanConnect(IPAddress.Loopback, loopbackPort, 1000);
                result.publicNetworkDenied = !CanConnect(IPAddress.Parse("1.1.1.1"), 80, 1500);
                result.isolationObserved =
                    result.tokenIsAppContainer &&
                    result.jobAssigned &&
                    result.stagingRead &&
                    result.stagingWrite &&
                    result.hostSentinelDenied &&
                    result.loopbackDenied &&
                    result.publicNetworkDenied;
            }
            catch (Exception exception)
            {
                result.error = exception.GetType().Name + ": " + exception.Message;
            }

            JavaScriptSerializer serializer = new JavaScriptSerializer();
            Console.Out.WriteLine(serializer.Serialize(result));
            return result.isolationObserved ? 0 : 1;
        }

        private static Dictionary<string, string> ParseOptions(string[] args)
        {
            if (args.Length != 6)
            {
                throw new InvalidOperationException("Expected --staging, --host-sentinel, and --loopback-port.");
            }

            Dictionary<string, string> values = new Dictionary<string, string>(StringComparer.Ordinal);
            for (int index = 0; index < args.Length; index += 2)
            {
                if (args[index] != "--staging" &&
                    args[index] != "--host-sentinel" &&
                    args[index] != "--loopback-port")
                {
                    throw new InvalidOperationException("Unknown option: " + args[index] + ".");
                }
                if (values.ContainsKey(args[index]))
                {
                    throw new InvalidOperationException("Duplicate option: " + args[index] + ".");
                }
                values.Add(args[index], args[index + 1]);
            }

            if (values.Count != 3)
            {
                throw new InvalidOperationException("Probe options are incomplete.");
            }
            return values;
        }

        private static void QueryToken(ProbeResult result)
        {
            IntPtr token = IntPtr.Zero;
            if (!NativeMethods.OpenProcessToken(NativeMethods.GetCurrentProcess(), NativeMethods.TOKEN_QUERY, out token))
            {
                throw new InvalidOperationException("OpenProcessToken failed with " + Marshal.GetLastWin32Error() + ".");
            }

            try
            {
                IntPtr value = Marshal.AllocHGlobal(sizeof(int));
                try
                {
                    int returned;
                    if (!NativeMethods.GetTokenInformation(
                        token,
                        NativeMethods.TokenIsAppContainer,
                        value,
                        sizeof(int),
                        out returned))
                    {
                        throw new InvalidOperationException("TokenIsAppContainer query failed with " + Marshal.GetLastWin32Error() + ".");
                    }
                    result.tokenIsAppContainer = Marshal.ReadInt32(value) != 0;
                }
                finally
                {
                    Marshal.FreeHGlobal(value);
                }

                int required;
                NativeMethods.GetTokenInformation(token, NativeMethods.TokenAppContainerSid, IntPtr.Zero, 0, out required);
                if (required <= 0)
                {
                    throw new InvalidOperationException("TokenAppContainerSid sizing failed with " + Marshal.GetLastWin32Error() + ".");
                }

                IntPtr sidInformation = Marshal.AllocHGlobal(required);
                try
                {
                    if (!NativeMethods.GetTokenInformation(
                        token,
                        NativeMethods.TokenAppContainerSid,
                        sidInformation,
                        required,
                        out required))
                    {
                        throw new InvalidOperationException("TokenAppContainerSid query failed with " + Marshal.GetLastWin32Error() + ".");
                    }

                    IntPtr sid = Marshal.ReadIntPtr(sidInformation);
                    IntPtr sidString = IntPtr.Zero;
                    try
                    {
                        if (sid == IntPtr.Zero || !NativeMethods.ConvertSidToStringSidW(sid, out sidString))
                        {
                            throw new InvalidOperationException("ConvertSidToStringSidW failed with " + Marshal.GetLastWin32Error() + ".");
                        }
                        result.appContainerSid = Marshal.PtrToStringUni(sidString);
                    }
                    finally
                    {
                        if (sidString != IntPtr.Zero)
                        {
                            NativeMethods.LocalFree(sidString);
                        }
                    }
                }
                finally
                {
                    Marshal.FreeHGlobal(sidInformation);
                }
            }
            finally
            {
                NativeMethods.CloseHandle(token);
            }
        }

        private static bool CanConnect(IPAddress address, int port, int timeoutMs)
        {
            Socket socket = new Socket(address.AddressFamily, SocketType.Stream, ProtocolType.Tcp);
            IAsyncResult pending = null;
            try
            {
                pending = socket.BeginConnect(address, port, null, null);
                if (!pending.AsyncWaitHandle.WaitOne(timeoutMs))
                {
                    return false;
                }
                socket.EndConnect(pending);
                return socket.Connected;
            }
            catch (SocketException)
            {
                return false;
            }
            catch (InvalidOperationException)
            {
                return false;
            }
            finally
            {
                if (pending != null)
                {
                    pending.AsyncWaitHandle.Close();
                }
                socket.Close();
            }
        }
    }
}
