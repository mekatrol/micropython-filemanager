import sys
import os
from pyboard import (
    Pyboard,
    main
)

if __name__ == "__main__":
    # Make sure remote files directory exists
    if not os.path.exists('__remote_files__'):
        os.makedirs('__remote_files__')

    # If only 1 arg (exe name) then run pyboard programatically
    if len(sys.argv) == 1:
        pyb = Pyboard("COM22", 115200, wait=0)
        pyb.enter_raw_repl()
        pyb.exec("import os")
        x = pyb.exec("print(os.getcwd(), end='')").decode(encoding="utf-8")
        print(x)
        pyb.fs_ls("/")
        pyb.exit_raw_repl()

    # Run pyboard main
    else:
        main()
