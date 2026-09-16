import type { PNMInput } from '@workspace/api-client-react';

export type PnmCreateForm = {
  firstName: string;
  lastName: string;
  email: string;
  major: string;
  year: string;
  semester: string;
};

export function toPnmInput(form: PnmCreateForm): PNMInput | null {
  const firstName = form.firstName.trim();
  const lastName = form.lastName.trim();
  if (!firstName || !lastName) return null;

  return {
    firstName,
    lastName,
    email: form.email.trim() || null,
    major: form.major.trim() || null,
    year: form.year.trim() || null,
    semester: form.semester.trim() || null,
  };
}