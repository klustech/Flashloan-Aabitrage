jest.mock("axios", () => ({
  create: () => ({
    get: jest.fn(),
    interceptors: { request: { use: jest.fn() }, response: { use: jest.fn() } },
  }),
}));
import { API, getSettings } from "./api";
test("settings API parses only known response metadata while retaining strict operator fields", async () => {
  const response = {
    flashbotsDefault: false,
    pollingInterval: 60,
    gasPriceCeiling: 70,
    slippageBips: 30,
    minBorrowAmount: 1,
    simulationInputAmount: 1000,
    botActive: false,
  };
  const mock = jest
    .spyOn(API, "get")
    .mockResolvedValue({
      data: {
        ...response,
        _persisted: true,
        _settingsFile: "runtime/operator-settings.json",
      },
    });
  try {
    expect(await getSettings()).toEqual(response);
    mock.mockResolvedValue({ data: { ...response, unknownOperatorField: 1 } });
    await expect(getSettings()).rejects.toThrow();
  } finally {
    mock.mockRestore();
  }
});
