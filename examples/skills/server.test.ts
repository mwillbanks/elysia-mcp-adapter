import { expect, test } from 'bun:test'
import { verifyPublishedSkill } from './client.js'
import { app } from './server.js'

test('pages, retrieves, and verifies exact skill bytes', async () => {
  await expect(verifyPublishedSkill(app)).resolves.toBeUndefined()
})
