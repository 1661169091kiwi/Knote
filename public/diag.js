// Diagnostic script to run in browser context
setTimeout(() => {
    console.log("--- DIAGNOSTIC START ---");
    const blocks = document.querySelectorAll('.md-block-container');
    console.log("Found containers:", blocks.length);
    if (blocks.length > 0) {
        const first = blocks[0];
        const inner = first.querySelector('div.pointer-events-auto') || first.querySelector('div');
        console.log("Inner click target:", inner);

        // Emulate click
        console.log("Dispatching click event...");
        inner.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));

        setTimeout(() => {
            const textarea = first.querySelector('textarea');
            console.log("Textarea after click:", textarea);
            if (!textarea) {
                // Why no textarea? 
                // Maybe handleBlockClick didn't fire? Let's check vue instance if possible, or just look at DOM.
                console.log("HTML:", first.innerHTML);
            } else {
                textarea.value += " Test Input";
                textarea.dispatchEvent(new Event('input', { bubbles: true }));
                console.log("Input dispatched");
            }
        }, 500);
    }
}, 2000);
