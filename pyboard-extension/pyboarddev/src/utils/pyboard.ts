/*
 * Pyboard.ts
 * 
 * TypeScript class for communicating with MicroPython devices over a serial port.
 * Adapted from: https://docs.micropython.org/en/latest/reference/pyboard.py.html
 * 
 * Provides methods to open/close serial ports, enter/exit raw REPL, execute commands,
 * and perform raw-paste writes to the MicroPython device.
 */

import * as vscode from 'vscode';
import { SerialPort } from 'serialport';
import { logChannelOutput } from '../output-channel';

export class Pyboard {
  device: string;              // Serial device path (e.g., "COM5", "/dev/ttyUSB0")
  baudrate: number;            // Serial baud rate, default 115200
  user: string;                // Device username (not used in this version)
  password: string;            // Device password (not used in this version)

  inRawRepl: boolean = false;  // Flag indicating if currently in raw REPL mode
  serialPort: SerialPort | undefined = undefined;  // Active SerialPort instance
  nextCommand: string | undefined = undefined;     // Stores next command to send

  useRawPaste: boolean = true; // Whether to attempt raw-paste mode
  waitDelay: number = 100;     // Milliseconds to wait after certain commands

  /**
   * Constructor for Pyboard class.
   * @param device Serial port device string
   * @param baudrate Serial baud rate (default: 115200)
   * @param user Optional username (default: "micro")
   * @param password Optional password (default: "python")
   */
  constructor(device: string, baudrate: number = 115200, user: string = 'micro', password: string = 'python') {
    this.device = device;
    this.baudrate = baudrate;
    this.user = user;
    this.password = password;
  }

  /**
   * Opens the serial port.
   */
  async open(): Promise<void> {
    if (this.serialPort !== undefined) {
      // If port already open, close first
      await this.close();
    }

    this.serialPort = new SerialPort({
      path: this.device,
      baudRate: this.baudrate,
      autoOpen: false
    });

    const serialPort = this.serialPort;
    return new Promise((resolve, reject) => {
      serialPort.open((err) => {
        if (err) {
          reject(this.reportError('Failed to open serial port', err));
          return;
        }
        resolve();
      });
    });
  }

  /**
   * Closes the serial port.
   */
  async close(): Promise<void> {
    if (this.serialPort === undefined) {
      return;
    }

    const serialPort = this.serialPort;

    return new Promise((resolve, reject) => {
      serialPort.close((err) => {
        if (err) {
          reject(this.reportError('Failed to close serial port', err));
          return;
        }
        this.serialPort = undefined;
        resolve();
      });
    });
  }

  /**
   * Delays execution for a given number of milliseconds.
   * @param ms Milliseconds to wait
   */
  async delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Enter raw REPL mode on the MicroPython device.
   */
  async enterRawRepl(): Promise<boolean> {
    await this.write('\r\x03');  // Ctrl-C to interrupt any running program
    await this.delay(this.waitDelay);
    await this.readAll();         // Clear any pending input
    await this.write('\r\x01');  // Ctrl-A to enter raw REPL
    await this.delay(this.waitDelay);

    // Wait for device to respond with the raw REPL prompt
    return await this.readUntil('raw REPL; CTRL-B to exit\r\n>');
  }

  /**
   * Writes a command using raw-paste mode.
   * @param commandBytes Command as byte array
   */
  async rawPasteWrite(commandBytes: number[]): Promise<boolean> {
    // Read header with window size
    const header = await this.readNextRaw(2);
    const windowSize = header[0];
    let windowRemain = windowSize;

    let i = 0;
    while (i < commandBytes.length) {
      while (windowRemain === 0) {
        const data = await this.serialPort!.read(1);
        if (!data || data.length === 0) {
          continue;
        }

        switch (data[0]) {
          case 0x01: // Window is ready for more data
            windowRemain += windowSize;
            continue;
          case 0x04: // End-of-data acknowledgment
            await this.write('\x04');
            continue;
          default:
            throw this.reportError('Unexpected byte during raw paste', new Error(String(data[0])));
        }
      }

      // Send as many bytes as window allows
      const bytes = commandBytes.slice(i, Math.min(i + windowRemain, commandBytes.length));
      this.serialPort!.write(bytes);
      windowRemain -= bytes.length;
      i += bytes.length;
    }

    await this.delay(this.waitDelay);
    await this.readAllRaw();   // Clear buffer
    await this.write('\x04');  // Signal end of data
    await this.delay(this.waitDelay);

    const endResponse = await this.readNextRaw(1);
    if (endResponse[endResponse.length - 1] !== 0x04) {
      throw this.reportError('Raw paste did not complete successfully', new Error(String(endResponse)));
    }

    const data = await this.readAllRaw();
    const str = String.fromCharCode(...data.filter((b) => b !== 0x04));
    logChannelOutput(str, false);

    return true;
  }

  /**
   * Execute a command without following its output.
   * @param command Command string or byte array
   */
  async execRawNoFollow(command: string | number[]): Promise<boolean> {
    let commandBytes: number[] = [];

    if (typeof command === 'string') {
      commandBytes = Array.from(command).map((c) => c.charCodeAt(0));
    } else {
      commandBytes = command;
    }

    if (this.useRawPaste) {
      await this.write('\x05A\x01'); // Initiate raw-paste mode
      await this.delay(this.waitDelay);

      const response = await this.readNextRaw(2);
      if (response.length < 2 || response[0] !== 'R'.charCodeAt(0)) {
        this.useRawPaste = false;
      } else if (response[1] === 1) {
        return await this.rawPasteWrite(commandBytes);
      } else {
        this.useRawPaste = false;
      }
    }

    // Fallback: normal raw REPL
    await this.write('\x04'); // End-of-data sequence
    await this.delay(this.waitDelay);

    const response2 = await this.readAllRaw();
    logChannelOutput(`Raw REPL fallback response: ${response2.join(',')}`, false);

    return true;
  }

  /**
   * Exit raw REPL mode and return to normal REPL.
   */
  async exitRawRepl(): Promise<boolean> {
    await this.readAll();       // Clear buffer
    await this.write('\r\x02'); // Ctrl-B to exit raw REPL
    await this.delay(this.waitDelay);

    return await this.readUntil('>>> ');
  }

  /**
   * Reads a specific number of bytes from the device.
   * @param length Number of bytes to read
   */
  async readNextRaw(length: number): Promise<number[]> {
    this.assertPortOpen();
    const bytes = await this.serialPort!.read(length);
    return bytes ?? [];
  }

  /**
   * Reads a specific number of bytes and converts to string.
   * @param length Number of bytes to read
   */
  async readNext(length: number): Promise<string> {
    const bytes = await this.readNextRaw(length);
    return bytes.length === 0 ? '' : String.fromCharCode(...bytes);
  }

  /**
   * Reads all available bytes from the device.
   * @param minLength Minimum number of bytes to read per chunk
   */
  async readAllRaw(minLength: number = 1): Promise<number[]> {
    this.assertPortOpen();
    let response: number[] = [];

    while (true) {
      const bytes = await this.serialPort!.read(minLength);
      if (!bytes) {
        break;
      }
      response = response.concat(...bytes);
    }

    return response;
  }

  /**
   * Reads all available bytes and converts to string.
   * @param minLength Minimum number of bytes to read per chunk
   */
  async readAll(minLength: number = 1): Promise<string> {
    const bytes = await this.readAllRaw(minLength);
    return String.fromCharCode(...bytes);
  }

  /**
   * Reads until a specific string appears at the end of the buffer.
   * @param str Target string
   */
  async readUntil(str: string): Promise<boolean> {
    this.assertPortOpen();
    const response = await this.readAll();
    return response.slice(-str.length) === str;
  }

  /**
   * Writes a string to the serial port.
   * @param data String to write
   */
  async write(data: string): Promise<void> {
    this.assertPortOpen();

    const buffer = new Uint8Array(data.length);
    for (let i = 0; i < data.length; i++) {
      buffer[i] = data.charCodeAt(i);
    }

    this.serialPort!.write(buffer, undefined, (err) => {
      if (err) {
        this.reportError('Failed to write to serial port', err);
      }
    });
  }

  /**
   * Execute a Python snippet in raw REPL and capture stdout/stderr.
   * The board must already be connected.
   */
  async execRawCapture(command: string, timeoutMs: number = 10000): Promise<{ stdout: string; stderr: string }> {
    this.assertPortOpen();

    const rawPrompt = Buffer.from('raw REPL; CTRL-B to exit\r\n>');

    await this.write('\r\x03');
    await this.delay(this.waitDelay);
    await this.readAllRaw();

    await this.write('\r\x01');
    await this.delay(this.waitDelay);
    await this.readUntilSuffix(rawPrompt, timeoutMs);

    await this.write(command);
    await this.write('\x04');

    const response = await this.readUntilSuffix(Buffer.from([0x04, 0x3e]), timeoutMs);

    await this.write('\r\x02');
    await this.delay(this.waitDelay);
    await this.readAllRaw();

    let payload = response;
    if (payload.length >= 2 && payload[0] === 'O'.charCodeAt(0) && payload[1] === 'K'.charCodeAt(0)) {
      payload = payload.slice(2);
    }

    const firstEot = payload.indexOf(0x04);
    if (firstEot < 0) {
      return { stdout: Buffer.from(payload).toString('utf8'), stderr: '' };
    }

    const stdoutBytes = payload.slice(0, firstEot);
    const remainder = payload.slice(firstEot + 1);
    const secondEot = remainder.lastIndexOf(0x04);
    const stderrBytes = secondEot >= 0 ? remainder.slice(0, secondEot) : remainder;

    return {
      stdout: Buffer.from(stdoutBytes).toString('utf8'),
      stderr: Buffer.from(stderrBytes).toString('utf8')
    };
  }

  private async readUntilSuffix(suffix: Buffer, timeoutMs: number): Promise<number[]> {
    this.assertPortOpen();

    const deadline = Date.now() + timeoutMs;
    const bytes: number[] = [];

    while (Date.now() < deadline) {
      const next = await this.serialPort!.read(1);
      if (!next || next.length === 0) {
        await this.delay(5);
        continue;
      }

      for (const value of next.values()) {
        bytes.push(value);
      }

      if (bytes.length >= suffix.length) {
        let match = true;
        const start = bytes.length - suffix.length;
        for (let i = 0; i < suffix.length; i += 1) {
          if (bytes[start + i] !== suffix[i]) {
            match = false;
            break;
          }
        }

        if (match) {
          return bytes.slice(0, -suffix.length);
        }
      }
    }

    throw this.reportError(
      `Timed out waiting for serial response suffix ${JSON.stringify(Array.from(suffix.values()))}`,
      new Error(`Timeout after ${timeoutMs}ms`)
    );
  }

  /**
   * Asserts that the serial port is open.
   * Throws an error if port is not open.
   */
  assertPortOpen() {
    if (!this.serialPort) {
      throw new Error('The serial port must be open to call this method');
    }
  }

  private reportError(context: string, error: unknown): Error {
    const detail = error instanceof Error ? error.message : String(error);
    const message = `${context}: ${detail}`;
    vscode.window.showErrorMessage(message);
    logChannelOutput(message, true);
    return new Error(message);
  }
}
