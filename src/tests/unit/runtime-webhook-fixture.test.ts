import { expect, spyOn, test } from "bun:test";
import * as crypto from "node:crypto";
import { RuntimeWebhookFixture } from "../fixtures/RuntimeWebhookFixture";

test("runtime TLS fixtures sample subnet octets uniformly from 1 through 250", () => {
	const random = spyOn(crypto, "randomInt")
		.mockImplementationOnce(() => 1)
		.mockImplementationOnce(() => 250);
	try {
		expect(new RuntimeWebhookFixture().address).toBe("11.254.1.2");
		expect(new RuntimeWebhookFixture().address).toBe("11.254.250.2");
		expect(random).toHaveBeenCalledTimes(2);
		expect(random).toHaveBeenNthCalledWith(1, 1, 251);
		expect(random).toHaveBeenNthCalledWith(2, 1, 251);
	} finally {
		random.mockRestore();
	}
});
