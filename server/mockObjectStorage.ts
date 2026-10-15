import { Response } from "express";
import { randomUUID } from "crypto";

export class MockObjectStorageService {
  private documents: Map<string, Buffer>;

  constructor() {
    this.documents = new Map();
  }

  async getObjectEntityUploadURL(): Promise<string> {
    const objectId = randomUUID();
    const mockPath = `/objects/uploads/${objectId}`;
    return mockPath;
  }

  normalizeObjectEntityPath(rawPath: string): string {
    if (rawPath.startsWith("http://localhost:5000")) {
      return rawPath.replace("http://localhost:5000", "");
    }
    if (rawPath.startsWith("http")) {
      const url = new URL(rawPath);
      return url.pathname;
    }
    return rawPath;
  }

  async trySetObjectEntityAclPolicy(
    rawPath: string,
    _aclPolicy: any
  ): Promise<string> {
    return this.normalizeObjectEntityPath(rawPath);
  }

  async downloadObject(objectPath: string, res: Response) {
    const document = this.documents.get(objectPath);
    if (!document) {
      return res.status(404).json({ error: "Document not found" });
    }

    res.set({
      "Content-Type": "application/octet-stream",
      "Content-Length": document.length,
      "Cache-Control": "public, max-age=3600",
    });

    res.send(document);
  }

  async storeDocument(objectPath: string, data: Buffer): Promise<void> {
    this.documents.set(objectPath, data);
  }

  async getDocumentBuffer(objectPath: string): Promise<Buffer | null> {
    const document = this.documents.get(objectPath);
    return document || null;
  }
}

export const mockObjectStorage = new MockObjectStorageService();
