export class ProposalService {
  createVersion(id: string): { id: string; immutable: true } {
    return { id, immutable: true };
  }
}
