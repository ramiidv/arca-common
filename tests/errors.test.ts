import { describe, expect, it } from 'vitest';
import {
  ArcaAuthError,
  ArcaError,
  ArcaSoapError,
  ArcaTicketVigenteError,
  ArcaValidationError,
} from '../src/errors.js';

/** Simula una segunda copia del paquete (ej: build CJS cargado junto al ESM). */
async function loadSecondCopy() {
  const url = new URL('../src/errors.ts', import.meta.url);
  url.searchParams.set('copy', '2');
  return (await import(/* @vite-ignore */ url.href)) as typeof import('../src/errors.js');
}

describe('errores', () => {
  it('tienen code estable y respetan la jerarquía', () => {
    const err = new ArcaTicketVigenteError('wsfe');
    expect(err.code).toBe('ARCA_TICKET_VIGENTE');
    expect(err.name).toBe('ArcaTicketVigenteError');
    expect(err).toBeInstanceOf(ArcaAuthError);
    expect(err).toBeInstanceOf(ArcaError);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(ArcaSoapError);
    expect(new ArcaValidationError('x', []).code).toBe('ARCA_VALIDATION_ERROR');
  });

  it('ArcaSoapError acepta el statusCode posicional (compatibilidad)', () => {
    const err = new ArcaSoapError('HTTP 500', 500);
    expect(err.statusCode).toBe(500);
    expect(err.uncertain).toBe(false);
  });

  it('instanceof funciona entre copias distintas del paquete', async () => {
    const copy = await loadSecondCopy();
    expect(copy.ArcaAuthError).not.toBe(ArcaAuthError);

    const fromCopy = new copy.ArcaTicketVigenteError('wsfe');
    expect(fromCopy).toBeInstanceOf(ArcaTicketVigenteError);
    expect(fromCopy).toBeInstanceOf(ArcaAuthError);
    expect(fromCopy).toBeInstanceOf(ArcaError);
    expect(fromCopy).not.toBeInstanceOf(ArcaSoapError);

    expect(new ArcaSoapError('x')).toBeInstanceOf(copy.ArcaError);
  });

  it('instanceof no da falsos positivos con objetos ajenos', () => {
    expect({ name: 'ArcaError' }).not.toBeInstanceOf(ArcaError);
    expect(new Error('x')).not.toBeInstanceOf(ArcaError);
    expect(null).not.toBeInstanceOf(ArcaError);
  });
});

describe('errores: code estático', () => {
  it('el code está en la clase y en la instancia', () => {
    expect(ArcaSoapError.code).toBe('ARCA_SOAP_ERROR');
    expect(new ArcaSoapError('x').code).toBe('ARCA_SOAP_ERROR');
  });

  it('instanceof entre copias no depende del nombre de la clase (minificación)', async () => {
    const copy = await loadSecondCopy();
    Object.defineProperty(copy.ArcaAuthError, 'name', { value: 'a' });
    expect(new copy.ArcaAuthError('x')).toBeInstanceOf(ArcaAuthError);
  });
});
