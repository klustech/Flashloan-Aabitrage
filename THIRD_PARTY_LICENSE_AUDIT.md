# Third-party dependency and source licensing audit

**Audit date:** 19 November 2026  
**Branch reviewed:** `main`  
**Scope:** repository manifests and lockfiles, selected Solidity interfaces, root licence notice and identified upstream licence declarations.  
**Status: Balancer GPL dependency blocker remediated in source/manifests; overall release still requires remaining provenance, inventory and legal checks.** This is a repository-level screening, not a legal opinion or a complete installed-artifact/SBOM audit.

## Executive summary

The repository's own top-level licence is MIT, but that does not mean every dependency or third-party-derived source file is MIT. The legacy GPL-3.0-only Balancer SDK/SOR dependencies identified in the initial audit have now been removed from the root and server manifests; Balancer quoting uses the Vault ABI directly. The frontend lockfile still has extensive missing licence metadata, and several Solidity interface files need provenance/header verification.

**Do not describe the complete project and all its dependencies as MIT-only. Do not remove or overwrite third-party licence notices to make the repository appear uniformly MIT.**

## 1. Dependency manifests and lockfiles

Three npm projects were identified:

| Manifest / lockfile | Locked package entries (including transitive and duplicated versions) | Production entries | Development entries | Initial finding |
|---|---:|---:|---:|---|
| Root `package.json` / `package-lock.json` | 1,078 | 247 | 831 | Two production GPL-3.0-only packages; nine dev entries have no lockfile licence field |
| `server/package.json` / `server/package-lock.json` | 248 | 218 | 30 | Same two production GPL-3.0-only packages; lockfile licence fields present for all entries |
| `frontend/package.json` / `frontend/package-lock.json` | 1,384 | 126 | 1,258 | 1,204 entries have no licence field in the lockfile, including 59 production entries |

Counts are lockfile package-location entries, not unique package names across the whole repository. The absence of a `license` field in a lockfile is **not proof that a package is unlicensed or proprietary**; it means its licence cannot be cleared from this lockfile alone. npm lockfiles describe the resolved dependency tree, but package licence metadata still needs verification against package licence files/registry metadata. See the [npm package-lock documentation](https://docs.npmjs.com/cli/v11/configuring-npm/package-lock-json).

### Resolved: legacy production GPL Balancer dependencies

The initial audit found these packages as regular production dependencies in the root/server manifests and lockfiles. They have now been removed from both manifests and their direct lockfile package entries:

| Package | Locked version | Declared licence | Repository usage found |
|---|---:|---|---|
| `@balancer-labs/sdk` | 1.1.6 | GPL-3.0-only | Dynamically required in `server/scripts/balancerUtils.js`; SOR is used through the SDK when available |
| `@balancer-labs/sor` | 4.1.3 | GPL-3.0-only | Direct dependency in both manifests; no separate direct source import was identified in the source search |

The package publishers identify both packages as GPLv3 / GPL-3.0-only: [Balancer SDK 1.1.6](https://www.npmjs.com/package/@balancer-labs/sdk) and [Balancer SOR 4.1.3](https://www.npmjs.com/package/@balancer-labs/sor).

This is the principal MIT-release compatibility issue. The SDK is dynamically loaded by application code, even though that code has a fallback to direct Balancer Vault calls if the SDK is unavailable. The fact that a fallback exists does not make a GPL dependency MIT-licensed, and it does not settle the legal treatment of distributing or running the combined application. The SOR package is also listed directly even though no separate direct import was found; it may still be brought in through the SDK.

**Required decision before release:** obtain advice from an open-source licensing solicitor on the combined-work implications, or remove/replace the GPL SDK integration and its direct dependency chain if the intention is to keep the distributed application MIT. Another route is to obtain appropriate separate permission/licensing from the rights holder. Do not assume simply changing `package.json` metadata or making the dependency optional resolves the issue.

### Other copyleft and non-permissive entries

The root lockfile also records development-tree packages under MPL-2.0 and LGPL-3.0, including several EthereumJS packages, `@resolver-engine/*`, and `web3-utils`. These are marked development-only in the lockfile, not production dependencies. They still need to be included in a complete attribution inventory where redistributed or bundled; their presence alone does not establish that the deployed runtime contains them.

The frontend lockfile records:
- `node-forge` 1.4.3 as `BSD-3-Clause OR GPL-2.0` in the development tree. The permissive BSD alternative appears to be available under the package's declared disjunctive expression, but retain the upstream notice.
- `caniuse-lite` as CC-BY-4.0 in the development tree. If its data is redistributed in generated materials, check the attribution requirements.
- 59 production and 1,145 development package entries without a lockfile licence field. These need resolution from the exact package versions' upstream licence files or registry metadata before sign-off.

The nine root lockfile entries without licence metadata are development-only: `death@1.1.0`, `difflib@0.2.4`, `source-map@0.2.0`, `estraverse@1.9.3`, `bufferutil@4.0.5`, `utf-8-validate@5.0.7`, `memorystream@0.3.1`, `prelude-ls@1.1.2`, and `rechoir@0.6.2`.

## 2. Solidity source and interface provenance

The root `LICENSE` is MIT and currently identifies two Aave-derived interfaces as AGPL-3.0. The corresponding files carry `SPDX-License-Identifier: agpl-3.0`:

- `contracts/interfaces/ILendingPool.sol`
- `contracts/interfaces/ILendingPoolAddressesProvider.sol`

This is consistent with the Aave Protocol V2 source headers and Aave's current code-licensing overview, which identifies Aave V2 smart contracts as AGPL: [Aave Protocol V2 ILendingPool](https://github.com/aave/protocol-v2/blob/master/contracts/interfaces/ILendingPool.sol), [Aave Protocol V2](https://github.com/aave/protocol-v2), [Aave code licensing](https://aave.com/docs/resources/code-licensing).

### Files requiring provenance review

| File | Current header | Why it needs review |
|---|---|---|
| `contracts/interfaces/IFlashLoanReceiver.sol` | MIT | The callback signature and flash-loan interface purpose correspond closely to the Aave V2 `IFlashLoanReceiver` interface, whose upstream file is AGPL-3.0. The local file is shortened and its comments differ, so derivation is not conclusively established by this screening. Verify the source/history and do not assume the MIT header is correct. [Aave upstream interface](https://github.com/aave/protocol-v2/blob/master/contracts/flashloan/interfaces/IFlashLoanReceiver.sol) |
| `contracts/interfaces/IUniswapV2Router02.sol` | MIT | Described in the source as a standard Uniswap V2 Router02 interface and contains matching Router02 method declarations. The upstream Uniswap V2 periphery repository is GPL-3.0. Verify whether this file was independently written from public ABI information or copied/adapted from upstream source; correct attribution and licence treatment if derived. [Upstream interface](https://github.com/Uniswap/v2-periphery/blob/master/contracts/interfaces/IUniswapV2Router02.sol), [upstream repository licence](https://github.com/Uniswap/v2-periphery) |
| `contracts/interfaces/IUniswapV2Factory.sol` | MIT | Contains standard Uniswap V2 factory declarations. Verify whether it was copied/adapted from the GPL-3.0 Uniswap V2 Core source or independently authored from the public interface. [Upstream interface](https://github.com/Uniswap/v2-core/blob/master/contracts/interfaces/IUniswapV2Factory.sol), [upstream licence](https://github.com/Uniswap/v2-core/blob/master/LICENSE) |
| `contracts/interfaces/IConnext.sol` | MIT | The file explicitly says it is a “local copy” of Connext Amarok interfaces, but does not identify the exact upstream file, commit/tag, copyright holder or licence source. The Connext monorepo is MIT-licensed, but the precise source revision and copied material must be recorded. [Connext monorepo](https://github.com/connext/monorepo) |

The interface SPDX headers are source declarations, not independent proof of ownership or licence. A short ABI declaration may raise different copyright questions from copied implementation code; have counsel review any uncertain provenance rather than mechanically re-licensing it.

Other inspected first-party contract files, including `ArbitrageFlashloan.sol`, `ArbitrageTimelock.sol` and `ConnextAdapter.sol`, declare MIT. This was a sample check, not a line-by-line provenance audit of every source file.

## 3. Python / ML dependencies

`ml/requirements.txt` lists LightGBM, scikit-learn, pandas, NumPy, psycopg2-binary, Flask, Gunicorn and python-dotenv using open-ended minimum versions. There is no Python lockfile in the repository tree.

As a result, exact resolved versions and transitive licences cannot be established from the repository snapshot. Generate a reproducible Python lock/SBOM and inspect the installed package licence files before claiming the ML dependency set is cleared. Pay particular attention to the exact psycopg2-binary distribution licence and its notices.

## 4. Other repository observations

- No checked-in `node_modules`, `vendor`, `third_party` or `external` directory was identified in the repository tree. This reduces the amount of vendored dependency code to inspect, but does not remove obligations for dependencies fetched at install/build time.
- Root, server and frontend manifests declare MIT for their own packages. The frontend manifest is marked `private: true`; that flag is an npm publishing setting, not a licence grant.
- The root `LICENSE` contains the MIT text and a file-specific Aave notice. It is not a complete third-party notices inventory for all dependencies.
- The repository contains no dedicated third-party notices/SBOM report at the time of this audit.

## 5. Required actions before public release

1. **Resolve Balancer GPL use.** Choose MIT-compatible replacement/removal, a separately distributed optional integration with legal review, or obtain suitable rights. Reassess both root and server manifests/lockfiles.
2. **Resolve Solidity provenance.** Verify the origin and correct SPDX/attribution for `IFlashLoanReceiver.sol`, both Uniswap interfaces and `IConnext.sol`. Preserve the existing Aave AGPL notices.
3. **Complete frontend metadata.** Resolve the 59 production entries and remaining development entries with missing lockfile licence fields using exact-version upstream licence texts. Do not treat missing metadata as permission.
4. **Lock Python dependencies.** Pin exact versions and generate a transitive licence inventory.
5. **Generate notices and an SBOM.** Produce a third-party notices file and SPDX or CycloneDX SBOM from clean installs for root, server and frontend; include the Python environment. Npm lockfiles provide the exact resolved dependency tree, but must be paired with licence-file inspection.
6. **Add a repeatable CI licence gate.** Fail on unknown or disallowed licences and require a documented, reviewed exception for any allowlist entry. A tool such as [Google's js-green-licenses](https://github.com/google/js-green-licenses) can be used as an additional npm check, not as the sole legal review.
7. **Obtain final legal sign-off.** Confirm that Klustertech owns or has assignments for all project-authored code and has authority to release the repository under the selected licence.

## Audit conclusion

**Current result: NOT CLEARED.**

The strongest blocker is the use of GPL-3.0-only Balancer SDK/SOR packages as production dependencies in an application whose own source is presented under MIT. There are also unresolved source-provenance questions in Solidity interfaces and a large frontend lockfile metadata gap. These issues are manageable, but they must be resolved and documented before public release.

This report is a technical screening based on repository metadata and selected upstream sources. It is not legal advice and does not determine whether any particular combination constitutes a derivative or combined work.
