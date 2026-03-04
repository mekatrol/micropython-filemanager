/*
 * Pyboard.ts
 * 
 * TypeScript class for communicating with MicroPython devices over a serial port.
 * Adapted from: https://docs.micropython.org/en/latest/reference/pyboard.py.html
 * 
 * Provides methods to open/close serial ports, enter/exit raw REPL, execute commands,
 * and perform raw-paste writes to the MicroPython device.
 */

import { SerialPort } from 'serialport';

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
    if (this.serialPort != undefined) {
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
          reject(err);
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
          reject(err);
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
        if (!data || data.length === 0) continue;

        switch (data[0]) {
          case 0x01: // Window is ready for more data
            windowRemain += windowSize;
            continue;
          case 0x04: // End-of-data acknowledgment
            await this.write('\x04');
            continue;
          default:
            throw new Error(`Unexpected byte during raw paste: ${data[0]}`);
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
      throw new Error(`Raw paste did not complete successfully: ${endResponse}`);
    }

    const data = await this.readAllRaw();
    const str = String.fromCharCode(...data.filter((b) => b !== 0x04));
    console.info(str);

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
    console.info(response2);

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
      if (!bytes) break;
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
      if (err) console.error(err);
    });
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
}