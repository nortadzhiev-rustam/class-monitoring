# Keeps a Windows student computer's sound off while the teacher has it muted
# (see src/student/mute.ts), through the Windows audio endpoint API.
#
# Runs until stdin closes: ClassMonitor closes it when the teacher unmutes, and
# it also closes when ClassMonitor quits or crashes. Either way every speaker
# it muted is put back as it was. Meanwhile it mutes whichever speakers are the
# default again every half second, so headphones plugged in or the volume keys
# don't bring the sound back.
#
# -DryRun prints "muted" / "unmuted" without touching the sound.

param([switch]$DryRun)

$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Threading;

// Only the methods called here have their real signatures; the others just
// hold their places in the COM vtable.
[ComImport, Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioEndpointVolume {
    int RegisterControlChangeNotify(); int UnregisterControlChangeNotify(); int GetChannelCount();
    int SetMasterVolumeLevel(); int SetMasterVolumeLevelScalar(); int GetMasterVolumeLevel(); int GetMasterVolumeLevelScalar();
    int SetChannelVolumeLevel(); int SetChannelVolumeLevelScalar(); int GetChannelVolumeLevel(); int GetChannelVolumeLevelScalar();
    [PreserveSig] int SetMute([MarshalAs(UnmanagedType.Bool)] bool mute, ref Guid eventContext);
    [PreserveSig] int GetMute([MarshalAs(UnmanagedType.Bool)] out bool mute);
}

[ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDevice {
    [PreserveSig] int Activate(ref Guid iid, int clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object endpoint);
    int OpenPropertyStore();
    [PreserveSig] int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
}

[ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceEnumerator {
    int EnumAudioEndpoints();
    [PreserveSig] int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice device);
}

[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
class MMDeviceEnumerator { }

public static class ClassMonitorAudio {
    const int RENDER = 0, CLSCTX_ALL = 23;
    /// eConsole, eMultimedia, eCommunications: usually one device, but each can be its own.
    static readonly int[] Roles = { 0, 1, 2 };
    static Guid context = Guid.Empty;

    class Speaker { public IAudioEndpointVolume Volume; public bool WasMuted; }
    static readonly Dictionary<string, Speaker> speakers = new Dictionary<string, Speaker>();
    static bool warned;

    /// Mutes the default speakers, remembering how each one was the first time it's seen.
    static void Silence(IMMDeviceEnumerator devices) {
        foreach (int role in Roles) {
            try {
                IMMDevice device;
                if (devices.GetDefaultAudioEndpoint(RENDER, role, out device) != 0 || device == null) continue;
                string id;
                if (device.GetId(out id) != 0 || id == null) continue;
                Speaker speaker;
                if (!speakers.TryGetValue(id, out speaker)) {
                    Guid iid = typeof(IAudioEndpointVolume).GUID;
                    object endpoint;
                    if (device.Activate(ref iid, CLSCTX_ALL, IntPtr.Zero, out endpoint) != 0 || endpoint == null) continue;
                    var volume = (IAudioEndpointVolume)endpoint;
                    bool muted;
                    if (volume.GetMute(out muted) != 0) continue;
                    speaker = new Speaker { Volume = volume, WasMuted = muted };
                    speakers[id] = speaker;
                }
                bool now;
                if (speaker.Volume.GetMute(out now) == 0 && !now) speaker.Volume.SetMute(true, ref context);
            } catch (Exception err) {
                // No speakers, or one was just unplugged: try again next time.
                if (!warned) Console.Error.WriteLine("Could not mute: " + err.Message);
                warned = true;
            }
        }
    }

    /// Puts every speaker this run muted back as it was.
    static void Restore() {
        foreach (var speaker in speakers.Values) {
            try { speaker.Volume.SetMute(speaker.WasMuted, ref context); } catch (Exception) { }
        }
        speakers.Clear();
    }

    /// Keeps the sound off until stdin closes.
    public static void Run(bool dryRun) {
        var closed = new ManualResetEvent(false);
        var reader = new Thread(delegate () {
            while (Console.In.ReadLine() != null) { }
            closed.Set();
        });
        reader.IsBackground = true;
        reader.Start();

        IMMDeviceEnumerator devices = dryRun ? null : (IMMDeviceEnumerator)new MMDeviceEnumerator();
        try {
            if (!dryRun) Silence(devices);
            Console.WriteLine("muted");
            while (!closed.WaitOne(500)) {
                if (!dryRun) Silence(devices);
            }
        } finally {
            Restore();
            Console.WriteLine("unmuted");
        }
    }
}
'@

[ClassMonitorAudio]::Run([bool]$DryRun)
