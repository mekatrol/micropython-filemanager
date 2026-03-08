/**
 * Module overview:
 * Canonical constants for MicroPython REPL control bytes and protocol text.
 * Keep serial command literals here to avoid magic values in transport/UI code.
 */

/**
 * Single-byte REPL control characters sent over serial.
 */
export const pyDeviceControlChars = {
  /** Enter raw REPL mode (Ctrl-A). */
  ctrlA: '\x01',
  /** Exit raw REPL mode (Ctrl-B). */
  ctrlB: '\x02',
  /** Interrupt running code (Ctrl-C). */
  ctrlC: '\x03',
  /** End-of-transmission / execute / soft reset (Ctrl-D). */
  ctrlD: '\x04',
  /** Enter paste-mode negotiation (Ctrl-E). */
  ctrlE: '\x05'
} as const;

/**
 * Numeric form of important protocol bytes.
 */
export const pyDeviceProtocolBytes = {
  ctrlD: 0x04,
  asciiGreaterThan: 0x3e,
  rawPasteWindowIncrement: 0x01,
  rawPasteSupportsMarker: 'R'.charCodeAt(0)
} as const;

/**
 * Multi-byte control sequences used by the connection protocol.
 */
export const pyDeviceCommandSequences = {
  interrupt: `\r${pyDeviceControlChars.ctrlC}`,
  interruptTwice: `\r${pyDeviceControlChars.ctrlC}${pyDeviceControlChars.ctrlC}`,
  enterRawRepl: `\r${pyDeviceControlChars.ctrlA}`,
  exitRawRepl: `\r${pyDeviceControlChars.ctrlB}`,
  startRawPasteNegotiation: `${pyDeviceControlChars.ctrlE}A${pyDeviceControlChars.ctrlA}`
} as const;

/**
 * Well-known REPL/protocol text emitted by MicroPython.
 */
export const pyDeviceProtocolText = {
  rawReplPrompt: 'raw REPL; CTRL-B to exit',
  rawReplPromptPrefix: 'raw REPL',
  rawReplPromptTail: '\r\n>',
  normalReplPrompt: '>>> ',
  softRebootBanner: 'soft reboot',
  rawCommandAcceptedPrefix: 'OK',
  runtimeInfoBeginMarker: '__PYDEVICE_INFO_BEGIN__',
  runtimeInfoEndMarker: '__PYDEVICE_INFO_END__',
  uniqueIdBeginMarker: '__PYDEVICE_UNIQUE_ID_BEGIN__',
  uniqueIdEndMarker: '__PYDEVICE_UNIQUE_ID_END__',
  helpHint: 'Type "help()" for more information.'
} as const;

/**
 * Pre-built buffers used for binary stream matching.
 */
export const pyDeviceProtocolBuffers = {
  rawReplPrompt: Buffer.from(pyDeviceProtocolText.rawReplPrompt),
  rawReplPromptPrefix: Buffer.from(pyDeviceProtocolText.rawReplPromptPrefix),
  rawReplPromptTail: Buffer.from(pyDeviceProtocolText.rawReplPromptTail),
  softRebootBanner: Buffer.from(pyDeviceProtocolText.softRebootBanner),
  rawCaptureResponseSuffix: Buffer.from([pyDeviceProtocolBytes.ctrlD, pyDeviceProtocolBytes.asciiGreaterThan])
} as const;

/**
 * UI-friendly control actions for REPL controls.
 */
export const pyDeviceReplControlActions = {
  interrupt: { byte: pyDeviceControlChars.ctrlC, label: 'Ctrl-C' },
  softReset: { byte: pyDeviceControlChars.ctrlD, label: 'Ctrl-D', isSoftReset: true },
  pasteMode: { byte: pyDeviceControlChars.ctrlE, label: 'Ctrl-E' }
} as const;
