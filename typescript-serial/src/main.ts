import { SerialPort } from 'serialport';
import { Pyboard } from './pyboard';

let pyboard: Pyboard | undefined = undefined;

const run = async (device: string, baudrate: number) => {
  console.info('**** Enumerating serial ports:');

  const ports = await SerialPort.list();
  ports.forEach((p) => {
    console.info(p.path);
  });

  console.info('**** Connecting to pyboard:');
  pyboard = new Pyboard(device, baudrate);

  try {
    await pyboard.open();
    console.info(`Enter REPL mode result: ${await pyboard.enterRawRepl()}`);
    console.info(`Exit  REPL mode result: ${await pyboard.exitRawRepl()}`);
  } catch (e) {
    console.error(e);
  } finally {
    try {
      await pyboard.close();
    } catch {
      /* do nothing with error, we are exiting */
    }
  }
};

run('COM22', 115200).then(() => {
  console.info('done!');
});
