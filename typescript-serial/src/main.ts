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
    const python = "import os\nfor f in os.ilistdir('/'):\n print('{:12} {}{}'.format(f[3]if len(f)>3 else 0,f[0],'/'if f[1]&0x4000 else ''))";

    console.info(`Enter REPL mode result: ${await pyboard.enterRawRepl()}`);
    console.info(`Enter raw paste result: ${await pyboard.execRawNoFollow(python)}`);
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
