import { formatUnits } from "./format";
test("token amounts retain large integer precision and use explicit decimals", () => {
  expect(formatUnits("161872667235238664762487", 18)).toBe("161,872.667235");
  expect(formatUnits("123456789", 6)).toBe("123.456789");
  expect(formatUnits("-1000000000000000001", 18)).toBe("−1");
  expect(formatUnits("1234", undefined)).toBe("—");
  expect(formatUnits(null, 18)).toBe("—");
});
