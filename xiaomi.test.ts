import assert from "node:assert/strict";
import { test } from "node:test";
import {
	parseXiaomiTokenPlanPayload,
	xiaomiTokenPlanUsageUrl,
	xiaomiUsageApiAuthHeaders,
} from "./src/xiaomi.ts";

// The documented response example (Query Token Plan Credits).
const samplePayload = () => ({
	object: "token_plan",
	plan_code: "pro",
	period: {
		start_at: "2026-09-21 23:59:59",
		end_at: "2027-09-21 23:59:59",
	},
	quota: {
		total_credits: 10000000,
		used_credits: 1500000,
		remaining_credits: 8500000,
	},
	auto_renew: false,
	claw_enabled: false,
});

// ───────── URL and auth headers ─────────

test("usage URL is derived from the dedicated base URL origin", () => {
	assert.equal(
		xiaomiTokenPlanUsageUrl("https://token-plan-cn.xiaomimimo.com/v1"),
		"https://token-plan-cn.xiaomimimo.com/v1/platform/token_plan",
	);
	assert.equal(
		xiaomiTokenPlanUsageUrl("https://token-plan-sgp.xiaomimimo.com"),
		"https://token-plan-sgp.xiaomimimo.com/v1/platform/token_plan",
	);
});

test("auth headers cover both documented auth methods", () => {
	assert.deepEqual(xiaomiUsageApiAuthHeaders("tp-secret"), {
		"Authorization": "Bearer tp-secret",
		"api-key": "tp-secret",
	});
});

// ───────── parseXiaomiTokenPlanPayload ─────────

test("parses the documented response example into a period window", () => {
	const parsed = parseXiaomiTokenPlanPayload(samplePayload())!;

	// The example period is a year, so it must use the monthly slot with a
	// "period" label override - never render it as "month".
	assert.equal(parsed.monthly?.label, "period");
	assert.equal(parsed.weekly, undefined);
	assert.equal(parsed.rolling, undefined);
	assert.equal(parsed.monthly?.usedPercent, 15);
	assert.equal(parsed.monthly?.remainingPercent, 85);
	// Timestamps are UTC per the API contract, not local time.
	assert.equal(parsed.monthly?.resetAt, Date.UTC(2027, 8, 21, 23, 59, 59) / 1000);
	assert.ok((parsed.monthly?.resetAfterSeconds ?? 0) > 0);

	assert.deepEqual(parsed.plan, {
		planCode: "pro",
		totalCredits: 10000000,
		usedCredits: 1500000,
		remainingCredits: 8500000,
		periodStartAt: Date.UTC(2026, 8, 21, 23, 59, 59) / 1000,
		periodEndAt: Date.UTC(2027, 8, 21, 23, 59, 59) / 1000,
		autoRenew: false,
		clawEnabled: false,
	});
});

test("short periods land in the weekly slot, still labeled period", () => {
	const payload = {
		...samplePayload(),
		period: { start_at: "2026-09-21 23:59:59", end_at: "2026-09-28 23:59:59" },
	};
	const parsed = parseXiaomiTokenPlanPayload(payload)!;
	assert.equal(parsed.weekly?.label, "period");
	assert.equal(parsed.monthly, undefined);
});

test("missing period keeps the window without a reset", () => {
	const parsed = parseXiaomiTokenPlanPayload({ ...samplePayload(), period: undefined })!;
	assert.equal(parsed.monthly?.usedPercent, 15);
	assert.equal(parsed.monthly?.resetAt, undefined);
	assert.equal(parsed.monthly?.resetAfterSeconds, undefined);
	assert.equal(parsed.plan?.periodStartAt, undefined);
	assert.equal(parsed.plan?.periodEndAt, undefined);
});

test("derives used percent from remaining when used is absent", () => {
	const payload = {
		...samplePayload(),
		quota: { total_credits: 100, remaining_credits: 85 },
	};
	const parsed = parseXiaomiTokenPlanPayload(payload)!;
	assert.equal(parsed.monthly?.usedPercent, 15);
	assert.equal(parsed.monthly?.remainingPercent, 85);
	assert.equal(parsed.plan?.usedCredits, undefined);
});

test("clamps percent and tolerates optional booleans and plan code", () => {
	const payload = {
		...samplePayload(),
		quota: { total_credits: 100, used_credits: 250, remaining_credits: -50 },
		plan_code: undefined,
		auto_renew: undefined,
		claw_enabled: undefined,
	};
	const parsed = parseXiaomiTokenPlanPayload(payload)!;
	assert.equal(parsed.monthly?.usedPercent, 100);
	assert.equal(parsed.monthly?.remainingPercent, 0);
	assert.equal(parsed.plan?.planCode, undefined);
	assert.equal(parsed.plan?.autoRenew, undefined);
	assert.equal(parsed.plan?.clawEnabled, undefined);
});

test("accepts numeric strings for credit fields", () => {
	const payload = {
		...samplePayload(),
		quota: { total_credits: "100", used_credits: "25", remaining_credits: "75" },
	};
	const parsed = parseXiaomiTokenPlanPayload(payload)!;
	assert.equal(parsed.monthly?.usedPercent, 25);
	assert.equal(parsed.monthly?.remainingPercent, 75);
});

test("rejects unusable payloads", () => {
	assert.equal(parseXiaomiTokenPlanPayload(undefined), undefined);
	assert.equal(parseXiaomiTokenPlanPayload(null), undefined);
	assert.equal(parseXiaomiTokenPlanPayload("token_plan"), undefined);
	assert.equal(parseXiaomiTokenPlanPayload({}), undefined);
	assert.equal(parseXiaomiTokenPlanPayload({ quota: {} }), undefined);
	assert.equal(parseXiaomiTokenPlanPayload({ quota: { total_credits: 0, used_credits: 1 } }), undefined);
	assert.equal(parseXiaomiTokenPlanPayload({ quota: { total_credits: 100 } }), undefined);
	assert.equal(parseXiaomiTokenPlanPayload({ quota: { total_credits: 100, used_credits: "NaN" } }), undefined);
});
