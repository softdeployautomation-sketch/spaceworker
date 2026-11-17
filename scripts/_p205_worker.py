import sys
p = 'lib/hosting/workers.ts'
s = open(p).read()
subs = [
    ('<title>Open this on your PC</title>', '<title>"+tEsc+"</title>'),
    ('<h1>Open this on your PC</h1>', '<h1>"+tEsc+"</h1>'),
    ('<p>This link opens best on a desktop computer. Please open it on your PC to continue.</p>', '<p>"+bEsc+"</p>'),
]
for a, b in subs:
    n = s.count(a)
    print('MATCHES', repr(a[:32]), n)
    if n != 1:
        print('FAIL: expected exactly 1 match')
        sys.exit(1)
    s = s.replace(a, b)
open(p, 'w').write(s)
print('WRITTEN OK')
