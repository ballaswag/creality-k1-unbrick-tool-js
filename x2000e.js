/* ============================================================================
 * INGENIC USB BOOT PROTOCOL
 * ========================================================================= */

const CPU_X2000 = "x2000";


const CPU_INFO = {
    "x2000": {
        vendor_id: 0xa108,
        product_id: 0xeaef,
    },
};

const VR_SET_DATA_ADDRESS = 1;
const VR_SET_DATA_LENGTH = 2;
const VR_FLUSH_CACHES = 3;
const VR_PROGRAM_START1 = 4;
const VR_PROGRAM_START2 = 5;
const VR_WRITE = 0x12;
const VR_READ = 0x13;

async function usb_vendor_req_data(device, request, argument, data) {
    await device.controlTransferOut({
        requestType: 'vendor',
        recipient: 'device',
        request: request,
        value: argument >> 16,
        index: argument & 0xffff
    }, data);
}

async function usb_vendor_req(device, request, argument) {
    await usb_vendor_req_data(device, request, argument, new Uint8Array(0));
}


async function usb_send(device, address, data) {
    await usb_vendor_req(device, VR_SET_DATA_ADDRESS, address);
    await usb_vendor_req(device, VR_SET_DATA_LENGTH, data.length);
    await device.transferOut(1, data);
}

const X2000_TCSM_BASE = 0xb2400000;

const X2000_SPL_LOAD_ADDR = X2000_TCSM_BASE + 0x1000;
const X2000_SPL_EXEC_ADDR = X2000_TCSM_BASE + 0x1800;

const X2000_STANDARD_DRAM_BASE = 0x80100000;

async function x2000_run_stage1(device, image) {
    await usb_send(device, X2000_SPL_LOAD_ADDR, image);
    await usb_vendor_req(device, VR_PROGRAM_START1, X2000_SPL_EXEC_ADDR);
}

async function x2000_run_stage2(device, image) {
    await usb_send(device, X2000_STANDARD_DRAM_BASE, image);
    await usb_vendor_req(device, VR_FLUSH_CACHES, 0);
    await usb_vendor_req(device, VR_PROGRAM_START2, X2000_STANDARD_DRAM_BASE);
}

function mmc_cursor_cmd(offset, length, crc) {
    const cmd = new ArrayBuffer(40);
    const cursor_cmd = new DataView(cmd);
    cursor_cmd.setUint32(8, 0x20000, true); // ops;
    cursor_cmd.setUint32(12, offset, true); // offset
    cursor_cmd.setUint32(16, length, true); // size
    cursor_cmd.setUint32(20, crc, true); // crc 
    
    return new Uint8Array(cmd);
}

function buf_eq(buf, xbuf, length) {
    if(xbuf.length < length || buf.length < length)
        return false;

    for(let ix = 0; ix < length; ++ix)
        if(buf[ix] !== xbuf[ix])
            return false;

    return true;
}

function buf_from_str(str) {
    let dat = [];
    for(let ix = 0; ix < str.length; ++ix)
        dat.push(str.charCodeAt(ix));

    return new Uint8Array(dat);
}

window.addEventListener('DOMContentLoaded', function(){
    const debug_console = document.getElementById('console');

    function debug_log(item) {
        debug_console.value += item + '\n';
    }

    async function retrieve_file(url) {
        debug_log("Downloading: '" + url + "'");

        let resp = await fetch(url);
        if(!resp.ok)
            throw new Error("Error downloading file: " + resp.statusText + " (" + resp.status + ")");

        let ret = new Uint8Array(await resp.arrayBuffer());
        debug_log("File downloaded, " + ret.byteLength + " bytes");

        return ret;
    }

    function add_button(id, callback){
        const el = document.getElementById(id);

        el.addEventListener('click', function(){
            el.disabled = true;
            callback().catch(function(e){
                debug_log(e);
            });

            el.disabled = false;
        });
    }

    function update_ui_state() {
        // Update the boot button text
        Array.from(document.getElementsByClassName('boot-button'))
            .forEach(function(x) {
                if(info !== undefined)
                    x.innerText = info.boot_button;
                else
                    x.innerText = "USB boot";
            });

        // Show/hide elements based on WebUSB support
        Array.from(document.getElementsByClassName('show-if-webusb'))
            .forEach(x => x.hidden = (navigator.usb === undefined));
        Array.from(document.getElementsByClassName('hide-if-webusb'))
            .forEach(x => x.hidden = (navigator.usb !== undefined));
    }


    add_button('button-load', async function() {
        if(navigator.usb === undefined)
            throw new Error('This browser does not support WebUSB');

        debug_log('Asking for device...');
        let device = await navigator.usb.requestDevice({
            filters: [{
                vendorId: CPU_INFO[CPU_X2000].vendor_id,
                productId: CPU_INFO[CPU_X2000].product_id,
            }]
        });

        debug_log('Opening device...');
        await device.open();

        try {
            debug_log('Claiming device interface...');
            await device.claimInterface(0);

	    let spl = await retrieve_file("files/bootloader/spl.bin");
	    let uboot = await retrieve_file("files/bootloader/uboot.bin");

            debug_log('Loading stage1 (SPL)...');
            await x2000_run_stage1(device, spl);

            debug_log('Pausing for SPL to come up...');
            await new Promise(x => setTimeout(x, 500));

            debug_log('Loading stage2 (bootloader)...');
            await x2000_run_stage2(device, uboot);

	    const blk_size = 512;
	    const ota_offset = 0x100000;

	    let read = mmc_cursor_cmd(ota_offset, blk_size, 0);
	    await usb_vendor_req_data(device, VR_READ, 0, read);
	    let ota  = await device.transferIn(1, blk_size);

	    let ota_kernel = buf_from_str("ota:kernel\n\n");
	    let ota_kernel2 = buf_from_str("ota:kernel2\n\n");

	    if (ota.status == "ok") {
		const ota_value = new Uint8Array(ota.data.buffer);
		if (buf_eq(ota_value, ota_kernel, ota_kernel.length)) {
		    debug_log("Current OTA has value ota:kernel, swapping to ota:kernel2");
		    let write = mmc_cursor_cmd(ota_offset, blk_size, 0xa2cb6b15);
		    await usb_vendor_req_data(device, VR_WRITE, 0, write);

		    const new_ota = new Uint8Array(blk_size);
		    new_ota.set(ota_kernel2);
		    await device.transferOut(1, new_ota);
		    debug_log("Updated OTA to ota:kernel2");
		    
		} else if (buf_eq(ota_value, ota_kernel2, ota_kernel2.length)) {
		    debug_log("Current OTA has value ota:kernel2, swapping to ota:kernel");
		    let write = mmc_cursor_cmd(ota_offset, blk_size, 0x7b2b4b8f);
		    await usb_vendor_req_data(device, VR_WRITE, 0, write);

		    const new_ota = new Uint8Array(blk_size);
		    new_ota.set(ota_kernel);
		    await device.transferOut(1, new_ota);
		    debug_log("Updated OTA to ota:kernel");
		} else {
		    debug_log("Error! unexpected OTA value found.");
		}
	    }

            debug_log('Closing device...');
            await device.close();

            debug_log('Done!');
        } catch(e) {
            await device.close();
            throw e;
        }
    });

    update_ui_state();
});
