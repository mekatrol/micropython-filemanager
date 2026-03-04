export interface PortInfo {
    path: string;
    manufacturer?: string;
    vendorId?: string;
    productId?: string;
}

/**
 * List all connected serial devices that have vendorId and productId (e.g., ESP32)
 */
export const listSerialDevices = async (): Promise<PortInfo[]> => {
    type SerialPortModule = typeof import('serialport');
    let SerialPort: SerialPortModule['SerialPort'];

    try {
        ({ SerialPort } = await import('serialport'));
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Serial support is unavailable (${message}). Reinstall dependencies in this extension folder and rebuild native modules for VS Code/Electron.`);
    }

    const ports = await SerialPort.list();

    return ports
        .filter(p => p.vendorId && p.productId)
        .map(p => ({
            path: p.path,
            manufacturer: p.manufacturer,
            vendorId: p.vendorId,
            productId: p.productId,
        }));
};
