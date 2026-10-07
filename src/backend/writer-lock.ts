import { constants, open } from 'node:fs/promises';
import { join } from 'node:path';

export async function acquireWriterLock(directory: string): Promise<() => Promise<void>> {
	if (process.platform !== 'darwin') throw new Error('Writer locking requires the verified macOS platform.');
	// Darwin fcntl.h: O_EXLOCK atomically opens and obtains a kernel flock.
	// Never unlink this file: all contenders must lock the same inode, including after a crash.
	const O_EXLOCK = 0x20;
	let file;
	try { file = await open(join(directory, 'writer.lock'), constants.O_CREAT | constants.O_RDWR | constants.O_NONBLOCK | O_EXLOCK, 0o600); }
	catch (error) {
		if (['EAGAIN', 'EWOULDBLOCK'].includes((error as NodeJS.ErrnoException).code ?? '')) {
			throw new Error('This index is occupied. Close the other window using this vault, then retry.');
		}
		throw error;
	}
	try {
		await file.truncate(0);
		await file.writeFile(JSON.stringify({ pid: process.pid, started: new Date().toISOString() }));
		return () => file.close();
	} catch (error) { await file.close(); throw error; }
}
