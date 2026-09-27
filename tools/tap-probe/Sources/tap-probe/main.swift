// tap-probe — decides the architecture of smooth-coffee-ai2.
//
// Since macOS 14.2 a Core Audio *tap* is an object with an input stream, and an
// aggregate device can carry taps. Apple's header says an aggregate with
// kAudioAggregateDeviceIsPrivateKey = 0 is published to the entire system. Does
// that mean a *different process* — Brave — can pick the resulting device with
// getUserMedia and hear the system mix? Every public implementation I can find
// (Apple's own sample, AudioCap, AudioTee, MiniMeters, Longwave) uses a private
// tap and reads it in-process, so nobody has answered it in the open.
//
// This program publishes a tap, then prints what a third party would see and
// tells you the two commands that constitute the actual answer.
//
// Run it with bundle.sh: recent macOS will not grant audio capture to a bare CLI
// binary, so it has to live in a bundle with NSAudioCaptureUsageDescription.
//
// NOT COMPILED BY THE AUTHOR — the dev box has no macOS SDK. If `swift build`
// complains, the compiler error is the fastest thing to paste back.

import CoreAudio
import Foundation

let aggregateUID = "coffee.smooth.probe.aggregate"
let deviceName = "SmoothCoffee Probe"

func fourCC(_ code: OSStatus) -> String {
    let raw = UInt32(bitPattern: code)
    let bytes: [UInt8] = [UInt8((raw >> 24) & 0xFF), UInt8((raw >> 16) & 0xFF),
                          UInt8((raw >> 8) & 0xFF), UInt8(raw & 0xFF)]
    let text = String(bytes: bytes.filter { (32..<127).contains($0) }, encoding: .ascii) ?? ""
    return text.isEmpty ? "?" : text
}

func report(_ status: OSStatus, _ what: String) -> Bool {
    guard status != noError else { return true }
    print("FAIL  \(what) -> OSStatus \(status) '\(fourCC(status))'")
    if status == kAudioHardwareIllegalOperationError {
        print("      usually: TCC has not granted Screen & System Audio Recording to this bundle yet,")
        print("      or an aggregate with UID \(aggregateUID) already exists (destroy it, or reboot).")
    }
    return false
}

/// CFString properties are read into a CFString sized with MemoryLayout<CFString>.stride,
/// which is what shipping implementations do. Not releasing leaks a string per read —
/// for a probe that reads a dozen, a better trade than an over-release crash.
func stringProperty(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector) -> String? {
    var address = AudioObjectPropertyAddress(mSelector: selector,
                                             mScope: kAudioObjectPropertyScopeGlobal,
                                             mElement: kAudioObjectPropertyElementMain)
    var value: CFString = "" as CFString
    var size = UInt32(MemoryLayout<CFString>.stride)
    let status = withUnsafeMutablePointer(to: &value) { pointer in
        AudioObjectGetPropertyData(object, &address, 0, nil, &size, pointer)
    }
    guard status == noError else { return nil }
    return value as String
}

func inputChannelCount(_ device: AudioObjectID) -> Int {
    var address = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyStreamConfiguration,
                                             mScope: kAudioObjectPropertyScopeInput,
                                             mElement: kAudioObjectPropertyElementMain)
    var size: UInt32 = 0
    guard AudioObjectGetPropertyDataSize(device, &address, 0, nil, &size) == noError, size > 0,
          let raw = malloc(Int(size)) else { return 0 }
    defer { free(raw) }
    guard AudioObjectGetPropertyData(device, &address, 0, nil, &size, raw) == noError else { return 0 }

    let list = raw.bindMemory(to: AudioBufferList.self, capacity: 1)
    let count = Int(list.pointee.mNumberBuffers)
    guard count > 0 else { return 0 }
    var channels = 0
    withUnsafeMutablePointer(to: &list.pointee.mBuffers) { head in
        let buffers = head.withMemoryRebound(to: AudioBuffer.self, capacity: count) { $0 }
        for index in 0..<count { channels += Int(buffers[index].mNumberChannels) }
    }
    return channels
}

func allDevices() -> [AudioObjectID] {
    var address = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyDevices,
                                             mScope: kAudioObjectPropertyScopeGlobal,
                                             mElement: kAudioObjectPropertyElementMain)
    var size: UInt32 = 0
    guard AudioObjectGetPropertyDataSize(kAudioObjectSystemObject, &address, 0, nil, &size) == noError,
          size > 0, let raw = malloc(Int(size)) else { return [] }
    defer { free(raw) }
    guard AudioObjectGetPropertyData(kAudioObjectSystemObject, &address, 0, nil, &size, raw) == noError
    else { return [] }
    let count = Int(size) / MemoryLayout<AudioObjectID>.size
    return raw.withMemoryRebound(to: AudioObjectID.self, capacity: count) {
        Array(UnsafeBufferPointer(start: $0, count: count))
    }
}

@discardableResult
func printDeviceTable(_ heading: String) -> AudioObjectID {
    print("\n== \(heading) ==")
    var ours = AudioObjectID(kAudioObjectUnknown)
    for device in allDevices() {
        let uid = stringProperty(device, kAudioDevicePropertyDeviceUID) ?? "?"
        let name = stringProperty(device, kAudioDevicePropertyDeviceNameCFString) ?? "?"
        let channels = inputChannelCount(device)
        let mark = uid == aggregateUID ? "   <-- the published aggregate" : ""
        print("  \(name.padding(toLength: 34, withPad: " ", startingAt: 0))  "
            + "uid=\(uid.padding(toLength: 32, withPad: " ", startingAt: 0))  inputs=\(channels)\(mark)")
        if uid == aggregateUID { ours = device }
    }
    return ours
}

print("tap-probe: can another process hear a Core Audio tap?")
print("macOS \(ProcessInfo.processInfo.operatingSystemVersionString)")

// 1. A tap over the whole system mix, marked PUBLIC.
let tapDescription = CATapDescription(stereoGlobalTapButExcludeProcesses: [])
tapDescription.name = deviceName
tapDescription.isPrivate = false

var tapID = AudioObjectID(kAudioObjectUnknown)
guard report(AudioHardwareCreateProcessTap(tapDescription, &tapID), "AudioHardwareCreateProcessTap")
else { exit(1) }
print("OK    tap object \(tapID) created with isPrivate = false")

var tapUID: CFString = "" as CFString
var uidAddress = AudioObjectPropertyAddress(mSelector: kAudioTapPropertyUID,
                                            mScope: kAudioObjectPropertyScopeGlobal,
                                            mElement: kAudioObjectPropertyElementMain)
var uidSize = UInt32(MemoryLayout<CFString>.stride)
let uidStatus = withUnsafeMutablePointer(to: &tapUID) { pointer in
    AudioObjectGetPropertyData(tapID, &uidAddress, 0, nil, &uidSize, pointer)
}
guard uidStatus == noError else {
    print("FAIL  kAudioTapPropertyUID -> \(uidStatus) '\(fourCC(uidStatus))'"); exit(1)
}
print("OK    tap uid \(tapUID)")

var format = AudioStreamBasicDescription()
var formatSize = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
var formatAddress = AudioObjectPropertyAddress(mSelector: kAudioTapPropertyFormat,
                                               mScope: kAudioObjectPropertyScopeGlobal,
                                               mElement: kAudioObjectPropertyElementMain)
if AudioObjectGetPropertyData(tapID, &formatAddress, 0, nil, &formatSize, &format) == noError {
    let interleaved = (format.mFormatFlags & kAudioFormatFlagIsNonInterleaved) != 0 ? " non-interleaved" : ""
    print("OK    format \(Int(format.mSampleRate)) Hz, \(format.mChannelsPerFrame) ch, "
        + "\(format.mBitsPerChannel) bits, '\(fourCC(format.mFormatID))'\(interleaved)")
}

// 2. An aggregate carrying that tap: published system-wide and started without a client.
let aggregate: [String: Any] = [
    kAudioAggregateDeviceNameKey: deviceName,
    kAudioAggregateDeviceUIDKey: aggregateUID,
    kAudioAggregateDeviceIsPrivateKey: 0,        // header: 0 = published to the entire system
    kAudioAggregateDeviceTapAutoStartKey: 1,
    kAudioAggregateDeviceTapListKey: [
        [kAudioSubTapUIDKey: tapUID as String,
         kAudioSubTapDriftCompensationKey: 1],
    ],
]

var aggregateID = AudioObjectID(kAudioObjectUnknown)
guard report(AudioHardwareCreateAggregateDevice(aggregate as CFDictionary, &aggregateID),
             "AudioHardwareCreateAggregateDevice") else {
    _ = AudioHardwareDestroyProcessTap(tapID)
    exit(1)
}
print("OK    aggregate device \(aggregateID) created (isPrivate = 0, tap autostart = 1)")

printDeviceTable("devices visible to this process")
usleep(500_000)
let published = printDeviceTable("devices 0.5 s later")

print("""

THE ANSWER IS IN ANOTHER PROCESS. While this window stays open, run:

  1)  system_profiler SPAudioDataType | grep -iA10 smoothcoffee
        -> is '\(deviceName)' listed, with Input Channels: 2?

  2)  In Brave, open the visualiser, press P, then in the devtools console:
        (await navigator.mediaDevices.enumerateDevices())
          .filter(d => d.kind === 'audioinput').map(d => d.label)
        -> is '\(deviceName)' among them?

  3)  If it is, select it, play music, and read:
        window.viz.state().rms
        -> non-zero rms from a second process means a public tap is consumable by
           getUserMedia, and the virtual-driver requirement disappears entirely.

If (1) lists the device but (3) stays silent, the tap is published but not
delivered across processes — fall back to PCM over WebSocket, which assumes nothing.

Press return to destroy the tap and exit.
""")

_ = readLine()
_ = AudioHardwareDestroyAggregateDevice(aggregateID)
_ = AudioHardwareDestroyProcessTap(tapID)
print("destroyed. Aggregate was visible from this process: \(published != kAudioObjectUnknown)")
