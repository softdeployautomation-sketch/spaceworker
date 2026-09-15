-- Second USDT wallet address, on the Ethereum (ERC20) chain — independent from
-- the existing usdtWallet (USDT-TRC20/Tron). Nullable, admin-configurable at
-- runtime like every other wallet/price field.
ALTER TABLE "AdminSetting" ADD COLUMN "usdtErc20Wallet" TEXT;
