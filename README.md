# Creality K1 (Max) Unbrick Tool

This tool attempts to unbrick the Creality K1 (Max) mainboard by switching boot to the
backup partitions. The tool uses WebUSB and the Creality K1's X2000E usb boot inteface
to access the boards MMC. It updates the OTA partition with one of `ota:kernel`
or `ota:kernel2`. The switching of this string allows the K1 boot process to try
alternative partitions.

For more detail visit https://github.com/ballaswag/ingenic-usbboot
