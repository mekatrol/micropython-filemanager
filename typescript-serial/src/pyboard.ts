/*
 * This code is adapted from: https://docs.micropython.org/en/latest/reference/pyboard.py.html
 */

import { SerialPort } from 'serialport';

export class Pyboard {
  device: string;
  baudrate: number;
  user: string;
  password: string;

  inRawRepl: boolean = false;
  serialPort: SerialPort | undefined = undefined;
  nextCommand: string | undefined = undefined;

  useRawPaste: boolean = true;

  /*
   * NOTE: only serial ports are currently supported as device string
   *   eg: "COM5", "/dev/ttyAMA0", "/dev/ttyUSB0"
   */
  constructor(device: string, baudrate: number = 115200, user: string = 'micro', password: string = 'python') {
    this.device = device;
    this.baudrate = baudrate;
    this.user = user;
    this.password = password;
  }

  async open(): Promise<void> {
    if (this.serialPort != undefined) {
      // The serial port is already open, so close it first
      this.close();
    }

    this.serialPort = new SerialPort({
      path: this.device,
      baudRate: this.baudrate,
      autoOpen: false
    });

    const serialPort = this.serialPort;
    return new Promise((resolve, reject) => {
      serialPort.open((e) => {
        if (e) {
          reject(e);
        }
        resolve();
      });
    });
  }

  async close(): Promise<void> {
    // If the serial port is already undefned then nothing to close
    if (this.serialPort === undefined) {
      return;
    }

    // Close and release the serial port
    const serialPort = this.serialPort;

    const releaseSerialPortInstance = () => {
      this.serialPort = undefined;
    };

    return new Promise((resolve, reject) => {
      serialPort.close((e) => {
        if (e) {
          reject(e);
        }

        releaseSerialPortInstance();
        resolve();
      });
    });
  }

  async delay(ms: number): Promise<void> {
    const delay = () => new Promise((resolve) => setTimeout(resolve, ms));
    await delay();
  }

  async enterRawRepl(): Promise<boolean> {
    // Ctrl-C interrupt running program
    await this.write('\r\x03');

    // Give board time to respond
    await this.delay(10);

    // Clear any unread data
    await this.readAll();

    // Ctrl-A enter raw REPL
    await this.write('\r\x01');

    // Give board time to respond
    await this.delay(10);

    // Return result of reading the expected response string
    return await this.readUntil('raw REPL; CTRL-B to exit\r\n>');
  }

  async rawPasteWrite(commandBytes: number[]): Promise<boolean> {
    // Read initial header, with window size.
    const x: number[] = await this.readNextRaw(2);

    const windowSize = x[0];
    let windowRemain = windowSize; // Window remaining starts at window size

    let i = 0;

    while (i < commandBytes.length) {
      while (windowRemain === 0) {
        const data = await this.serialPort!.read(1);

        if (data.length === 0) {
          // No data was read
          continue;
        }

        switch (data[0]) {
          case 0x01:
            // Device indicated that a new window of data can be sent.
            windowRemain += windowSize;
            continue;

          case 0x04:
            await this.write('\x04');
            continue;

          default:
            throw new Error(`unexpected read during raw paste: ${data[0]}`);
        }
      }

      // Send out as much data as possible that fits within the allowed window.
      const bytes = commandBytes.slice(i, Math.min(i + windowRemain, commandBytes.length));
      this.serialPort!.write(bytes);
      windowRemain -= bytes.length;
      i += bytes.length;
    }

    await this.delay(10);

    // Clear any unread data
    await this.readAllRaw();

    // Indicate end of data.
    await this.write('\x04');

    await this.delay(10);

    const endOfDataResponse = await this.readNextRaw(1);
    if (endOfDataResponse[endOfDataResponse.length - 1] !== 0x04) {
      throw new Error(`could not complete raw paste: ${endOfDataResponse}`);
    }

    // Wait for device to acknowledge end of data.
    const data = await this.readAllRaw();
    const filteredData = data.filter((b) => b != 0x04);
    const str = String.fromCharCode(...filteredData);
    console.log(str);

    return true;
  }

  async execRawNoFollow(command: string | number[]): Promise<boolean> {
    let commandBytes: number[] = [];

    if (typeof command === typeof String) {
      // Convert string to bytes
      for (let i = 0; i < command.length; i++) {
        commandBytes.push((command as string).charCodeAt(i));
      }
    } else {
      // Already a byte array
      commandBytes = command as number[];
    }

    if (this.useRawPaste) {
      // Enter raw past sequence
      await this.write('\x05A\x01');

      // Give board time to respond
      await this.delay(10);

      // Return result of reading the expected response string
      const response = await this.readNextRaw(2);

      if (response.length < 2) {
        // Did not get 2 bytes in response, so can't use raw paste
        this.useRawPaste = false;
      }

      // Expecting 'R' as first character
      if (response[0] !== 'R'.charCodeAt(0)) {
        return false;
      }

      if (response[1] === 1) {
        // Device supports raw-paste mode, write out the command using this mode.
        return await this.rawPasteWrite(commandBytes);
      }

      // Device understood raw-paste command but doesn't support it or
      // Device doesn't support raw-paste, fall back to normal raw REPL.
      this.useRawPaste = false;
    }

    // End of data sequence
    await this.write('\x04');

    // Give board time to respond
    await this.delay(10);

    // Return result of reading the expected response string
    const response2 = await this.readAllRaw();

    console.log(response2);

    return true;
  }

  async exitRawRepl(): Promise<boolean> {
    // Clear any unread data
    await this.readAll();

    await this.write('\r\x02');

    // Give board time to respond
    await this.delay(10);

    // Return result of reading the expected response string
    return await this.readUntil('>>> ');
  }

  async readNextRaw(length: number): Promise<number[]> {
    // Ensure port open
    this.assertPortOpen();

    // Read length bytes
    const bytes = await this.serialPort!.read(length);

    // Return read bytes or empty array if none read
    return bytes ?? [];
  }

  async readNext(length: number): Promise<string> {
    const bytes = await this.readNextRaw(length);

    if (bytes.length === 0) {
      // No bytes so return empty string
      return '';
    }

    // Convert array bytes number values to ASCII character values (string)
    return String.fromCharCode(...bytes);
  }

  async readAllRaw(minLength: number = 1): Promise<number[]> {
    this.assertPortOpen();

    let response: number[] = [];

    while (true) {
      const bytes = await this.serialPort!.read(minLength);

      if (!bytes) {
        // Have read to the end of the rx buffer
        break;
      }

      // Append to response
      response = response.concat(...bytes);
    }

    return response;
  }

  async readAll(minLength: number = 1): Promise<string> {
    this.assertPortOpen();

    // Read raw bytes
    const bytes = await this.readAllRaw(minLength);

    // Convert number values to ASCII character values
    return String.fromCharCode(...bytes);
  }

  async readUntil(str: string): Promise<boolean> {
    this.assertPortOpen();

    // Read all buffered bytes
    const response = await this.readAll();

    // Return true if the ends of the strings matched
    const responseEnd = response.substring(Math.max(0, response.length - str.length));
    return responseEnd == str;
  }

  async write(data: string): Promise<void> {
    this.assertPortOpen();

    const dataArray = new Uint8Array(data.length);

    for (let i = 0; i < data.length; i++) {
      const c = data.charCodeAt(i);
      dataArray[i] = c;
    }

    this.serialPort!.write(dataArray, undefined, (e) => {
      if (e) {
        console.error(e);
      }
    });
  }

  assertPortOpen() {
    if (this.serialPort === undefined) {
      throw new Error('The serial port must be open to call this method');
    }
  }

  // async execRawNoFollow(command: string | ArrayBuffer): Promise<void> {}
}
