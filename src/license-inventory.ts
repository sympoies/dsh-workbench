export interface DependencyLicense {
  name: string;
  version: string;
  license: string;
}

export interface DependencyLicenseInventory {
  schemaVersion: 'dsh-workbench.dependency-license-inventory.v1';
  packageCount: number;
  packages: DependencyLicense[];
}

export type LicenseReportErrorCode =
  | 'invalid-report'
  | 'invalid-license-group'
  | 'invalid-package-group'
  | 'invalid-package-entry'
  | 'invalid-package-name'
  | 'invalid-license-metadata'
  | 'inconsistent-license-metadata'
  | 'missing-package-versions'
  | 'invalid-package-version'
  | 'conflicting-package-license'
  | 'empty-production-inventory';

const errorMessages: Record<LicenseReportErrorCode, string> = {
  'invalid-report': 'pnpm license report must be a non-empty license map',
  'invalid-license-group': 'pnpm license report has an invalid license group',
  'invalid-package-group': 'pnpm license report has an invalid package group',
  'invalid-package-entry': 'pnpm license report has an invalid package entry',
  'invalid-package-name': 'pnpm license report has an invalid package name',
  'invalid-license-metadata': 'pnpm license report has invalid license metadata',
  'inconsistent-license-metadata': 'pnpm license report has inconsistent license metadata',
  'missing-package-versions': 'pnpm license report has no package versions',
  'invalid-package-version': 'pnpm license report has an invalid package version',
  'conflicting-package-license': 'pnpm license report has conflicting package licenses',
  'empty-production-inventory': 'pnpm license report contains no production packages',
};

export class LicenseReportError extends Error {
  readonly code: LicenseReportErrorCode;

  constructor(code: LicenseReportErrorCode) {
    super(errorMessages[code]);
    this.code = code;
    this.name = 'LicenseReportError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredText(value: unknown, code: LicenseReportErrorCode, maxLength = 512): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maxLength ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new LicenseReportError(code);
  }
  return value;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Reduce pnpm license-list JSON from the production-only profile to package
 * identity and declared license only. In particular, pnpm's install paths and
 * package authors are not part of the public inventory.
 */
export function normalizePnpmLicenseReport(input: unknown): DependencyLicenseInventory {
  if (!isRecord(input) || Object.keys(input).length === 0) {
    throw new LicenseReportError('invalid-report');
  }

  const byPackage = new Map<string, DependencyLicense>();
  for (const [licenseGroupValue, rows] of Object.entries(input)) {
    const licenseGroup = requiredText(licenseGroupValue, 'invalid-license-group', 256);
    if (!Array.isArray(rows)) {
      throw new LicenseReportError('invalid-package-group');
    }

    for (const row of rows) {
      if (!isRecord(row)) {
        throw new LicenseReportError('invalid-package-entry');
      }
      const name = requiredText(row.name, 'invalid-package-name');
      const license = requiredText(row.license, 'invalid-license-metadata', 256);
      if (license !== licenseGroup) {
        throw new LicenseReportError('inconsistent-license-metadata');
      }
      if (!Array.isArray(row.versions) || row.versions.length === 0) {
        throw new LicenseReportError('missing-package-versions');
      }

      for (const versionValue of row.versions) {
        const version = requiredText(versionValue, 'invalid-package-version');
        const key = `${name}\u0000${version}`;
        const current = byPackage.get(key);
        if (current && current.license !== license) {
          throw new LicenseReportError('conflicting-package-license');
        }
        byPackage.set(key, { name, version, license });
      }
    }
  }

  const packages = [...byPackage.values()].sort(
    (left, right) =>
      compareText(left.name, right.name) ||
      compareText(left.version, right.version) ||
      compareText(left.license, right.license),
  );
  if (packages.length === 0) {
    throw new LicenseReportError('empty-production-inventory');
  }

  return {
    schemaVersion: 'dsh-workbench.dependency-license-inventory.v1',
    packageCount: packages.length,
    packages,
  };
}
