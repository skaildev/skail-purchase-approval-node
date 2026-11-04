import { OrderLimits } from "@skail-purchase-approval/contracts";

export interface Deadlines {
  managerSeconds: number;
  directorSeconds: number;
}

function seconds(env: NodeJS.ProcessEnv, name: string): number {
  const raw = env[name]?.trim();
  if (!raw) return OrderLimits.defaultDeadlineSeconds;
  const value = Number(raw);
  // the deadline becomes Skail.delaySeconds(...): it must be a finite, positive whole number
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value <= 0)
    throw new Error(`${name} must be a positive whole number of seconds, got '${raw}'`);
  return value;
}

export function deadlinesFromEnvironment(env: NodeJS.ProcessEnv = process.env): Deadlines {
  return {
    managerSeconds: seconds(env, "APPROVAL_MANAGER_DEADLINE_SECONDS"),
    directorSeconds: seconds(env, "APPROVAL_DIRECTOR_DEADLINE_SECONDS"),
  };
}
