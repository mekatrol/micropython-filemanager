export interface PortInfo {
    path: string;
    manufacturer?: string;
    vendorId?: string;
    productId?: string;
}

/**
 * List all visible serial ports.
 */
export const listAllSerialPorts = async (): Promise<PortInfo[]> => {
    type SerialPortModule = typeof import('serialport');
    let SerialPort: SerialPortModule['SerialPort'];

    try {
        ({ SerialPort } = await import('serialport'));
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Serial support is unavailable (${message}). Reinstall dependencies in this extension folder and rebuild native modules for VS Code/Electron.`);
    }

    const ports = await SerialPort.list();

    return ports.map((p) => ({
        path: p.path,
        manufacturer: p.manufacturer,
        vendorId: p.vendorId,
        productId: p.productId,
    }));
};

/**
 * List connected serial devices that expose VID/PID metadata (typical USB serial devices).
 */
export const listSerialDevices = async (): Promise<PortInfo[]> => {
    const ports = await listAllSerialPorts();
    return ports.filter((port) => port.vendorId && port.productId);
};
