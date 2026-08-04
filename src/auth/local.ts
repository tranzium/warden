import { config } from '../shared/config'

export async function verifyLocalCredentials(username: string, password: string): Promise<boolean> {
	if (!config.localPasswordHash) return false
	if (username !== config.localUsername) return false
	try {
		return await Bun.password.verify(password, config.localPasswordHash)
	} catch {
		return false
	}
}
