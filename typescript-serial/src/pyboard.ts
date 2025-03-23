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

    // Read any extraneous received characters
    await this.readAll();

    // Ctrl-A enter raw REPL
    await this.write('\r\x01');

    // Give board time to respond
    await this.delay(10);

    // Return result of reading the expected response string
    return await this.readUntil('raw REPL; CTRL-B to exit\r\n>');
  }

  async exitRawRepl(): Promise<boolean> {
    // Read any extraneous received characters
    await this.readAll();

    await this.write('\r\x02');

    // Give board time to respond
    await this.delay(10);

    // Return result of reading the expected response string
    return await this.readUntil('>>> ');
  }

  async readAll(minLength: number = 1): Promise<string> {
    this.assertPortOpen();

    let response: string = '';

    while (true) {
      const bytes = await this.serialPort!.read(minLength);

      if (!bytes) {
        // Have read to the end of the buffer
        break;
      }

      // Convert to ASCII
      for (let i = 0; i < bytes.length; i++) {
        // Convert number value to ASCII character value
        const c = String.fromCharCode(bytes[i]);

        // Append to string
        response += c;
      }
    }

    return response;
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
}
