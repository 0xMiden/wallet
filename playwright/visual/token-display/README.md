# Token display visual check

This fixture renders the production `AssetListItem` and `AmountInput` components with fixed display data. It verifies the unavailable-price slot beside a selected token and the normalized USD amount at narrow widths in both themes. Those cases also keep the full quantity and unit inside the selected row, separate from the price slot and the check. It does not create a wallet, fetch prices, or submit transactions.
