import chai from 'chai'
import SinonChai from 'sinon-chai'
import Subset from 'chai-subset'
import { ResolvedConfig } from 'vitest'
import { JestChaiExpect } from './jest-expect'
import { SnapshotPlugin } from './snapshot'

export async function setupChai(config: ResolvedConfig) {
  chai.use(SinonChai)
  chai.use(JestChaiExpect())
  chai.use(Subset)
  chai.use(await SnapshotPlugin(config))
}
